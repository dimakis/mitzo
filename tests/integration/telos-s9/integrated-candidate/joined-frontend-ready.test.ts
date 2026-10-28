import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type DevEnvironment, type InlineConfig } from 'vite';
import { expect, it, vi } from 'vitest';
import { prepareJoinedFrontend } from './joined-frontend-ready';

it('prepares dynamic boot and route entries before returning without a browser', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'joined-frontend-ready-')));
  const transformed: string[] = [];
  await writeFile(join(root, 'main.js'), 'void import("./render.js");');
  await writeFile(join(root, 'render.js'), 'export const render = () => import("./route.js");');
  await writeFile(
    join(root, 'route.js'),
    'import { value } from "./dependency.js"; console.log(value);',
  );
  await writeFile(join(root, 'dependency.js'), 'export const value = 42;');
  const configuration = {
    configFile: false,
    root,
    cacheDir: join(root, 'private-cache'),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null, fs: { allow: [root] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'observe-transforms',
        transform(_code: string, id: string) {
          transformed.push(id);
        },
      },
    ],
  } satisfies InlineConfig;
  const cold = await createServer(configuration);
  try {
    await cold.environments.client.transformRequest('/main.js');
    await cold.environments.client.waitForRequestsIdle();
    // The original single-entry warmup never crosses these dynamic boundaries.
    expect(transformed).not.toContain(join(root, 'dependency.js'));
  } finally {
    await cold.close();
  }
  transformed.length = 0;
  const vite = await createServer(configuration);
  try {
    await prepareJoinedFrontend(vite.environments.client, ['/main.js', '/render.js', '/route.js']);
    expect(transformed).toContain(join(root, 'dependency.js'));
    const dependency = await vite.environments.client.moduleGraph.getModuleByUrl('/dependency.js');
    expect(dependency?.transformResult?.code).toContain('42');
    const before = transformed.length;
    await vite.environments.client.transformRequest('/dependency.js');
    expect(transformed).toHaveLength(before);
  } finally {
    await vite.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts every explicit entry and waits for all transforms before the static-import idle barrier', async () => {
  const transforms: Array<(value: unknown) => void> = [];
  let idle!: () => void;
  const client = {
    transformRequest: vi.fn<(url: string) => Promise<unknown>>(
      () =>
        new Promise((resolve) => {
          transforms.push(resolve);
        }),
    ),
    waitForRequestsIdle: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          idle = resolve;
        }),
    ),
  };
  let ready = false;
  const preparation = prepareJoinedFrontend(client as unknown as DevEnvironment).then(() => {
    ready = true;
  });
  expect(client.transformRequest.mock.calls.map((args) => args[0])).toEqual([
    '/src/main.tsx',
    '/src/render-app.tsx',
    '/src/components/ResponsiveChatView.tsx',
    '/src/pages/TaskBoard.tsx',
  ]);
  expect(client.waitForRequestsIdle).not.toHaveBeenCalled();
  for (const resolve of transforms.slice(1)) resolve({ code: 'entry' });
  await Promise.resolve();
  expect(client.waitForRequestsIdle).not.toHaveBeenCalled();
  transforms[0]({ code: 'entry' });
  await vi.waitFor(() => expect(client.waitForRequestsIdle).toHaveBeenCalledOnce());
  expect(ready).toBe(false);
  idle();
  await preparation;
  expect(ready).toBe(true);
});

it.each(['missing-entry', 'transform-error', 'idle-error'])(
  'rejects %s instead of admitting the browser',
  async (failure) => {
    const error = Error('Synthetic preparation failure');
    const client = {
      transformRequest: vi.fn(async (url: string) => {
        if (failure === 'transform-error') throw error;
        return failure === 'missing-entry' && url === '/src/pages/TaskBoard.tsx'
          ? null
          : { code: 'entry' };
      }),
      waitForRequestsIdle: vi.fn(async () => {
        if (failure === 'idle-error') throw error;
      }),
    };
    await expect(prepareJoinedFrontend(client as unknown as DevEnvironment)).rejects.toThrow(
      failure === 'missing-entry' ? 'Joined frontend entry unavailable' : error,
    );
    expect(client.waitForRequestsIdle).toHaveBeenCalledTimes(failure === 'idle-error' ? 1 : 0);
  },
);
