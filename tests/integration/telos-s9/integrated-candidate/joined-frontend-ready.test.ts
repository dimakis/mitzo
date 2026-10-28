import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type DevEnvironment } from 'vite';
import { expect, it, vi } from 'vitest';
import { prepareJoinedFrontend } from './joined-frontend-ready';

it('prepares the real client entry and its static dependency before returning without a browser', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'joined-frontend-ready-')));
  const transformed: string[] = [];
  await writeFile(
    join(root, 'main.js'),
    'import { value } from "./dependency.js"; console.log(value);',
  );
  await writeFile(join(root, 'dependency.js'), 'export const value = 42;');
  const vite = await createServer({
    configFile: false,
    root,
    cacheDir: join(root, 'private-cache'),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null, fs: { allow: [root] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      {
        name: 'observe-transforms',
        transform(_code, id) {
          transformed.push(id);
        },
      },
    ],
  });
  try {
    await prepareJoinedFrontend(vite.environments.client, '/main.js');
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

it('waits for both the entry transform and static-import idle barrier', async () => {
  let transformed!: (value: unknown) => void;
  let idle!: () => void;
  const client = {
    transformRequest: vi.fn(
      () =>
        new Promise((resolve) => {
          transformed = resolve;
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
  expect(client.transformRequest).toHaveBeenCalledWith('/src/main.tsx');
  expect(client.waitForRequestsIdle).not.toHaveBeenCalled();
  transformed({ code: 'entry' });
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
      transformRequest: vi.fn(async () => {
        if (failure === 'transform-error') throw error;
        return failure === 'missing-entry' ? null : { code: 'entry' };
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
