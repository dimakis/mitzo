import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ToolBuilderService,
  type ToolBuilderCatalog,
  type ToolBuilderWorkspace,
} from '../tool-builder.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<ToolBuilderWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-'));
  roots.push(root);
  return {
    id: 'workspace-fixture',
    root,
    write: async (relativePath, content) => {
      const path = join(root, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content, { flag: 'wx' });
    },
    read: async (relativePath) => readFile(join(root, relativePath), 'utf8'),
  };
}

const customRequest = {
  name: 'CSV row count',
  description: 'Count rows in a CSV file while ignoring the header.',
  inputSchema: { type: 'object', properties: { csv: { type: 'string' } }, required: ['csv'] },
  examples: [{ input: { csv: 'name\nAda\nLin' }, expected: { count: 2 } }],
  permissions: { behavior: 'read' as const, requiredConnections: [] },
  compatibility: { routes: ['local-api'] },
  files: [
    {
      path: 'src/index.ts',
      content:
        'export function countRows(csv: string) { return csv.trim().split("\\n").length - 1; }\n',
    },
  ],
  testProfile: 'unit',
};

it('reuses an equivalent catalog entry without allocating a workspace or publishing a duplicate', async () => {
  const catalog: ToolBuilderCatalog = {
    search: vi.fn(async () => [
      {
        id: 'mitzo:Read',
        version: 1,
        name: 'Read CSV',
        description: 'Read and count CSV rows',
        equivalent: true,
      },
    ]),
  };
  const allocateWorkspace = vi.fn(workspace);
  const service = new ToolBuilderService({
    catalog,
    allocateWorkspace,
    executor: { run: vi.fn() },
  });

  const result = await service.propose({ request: 'Count rows in a CSV file' });

  expect(result).toMatchObject({ kind: 'reuse', tool: { id: 'mitzo:Read', version: 1 } });
  expect(allocateWorkspace).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('draft');
});

it('prepares a tested unpublished custom draft inside the authorized workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-'));
  roots.push(root);
  const ws: ToolBuilderWorkspace = {
    id: 'authorized-workspace',
    root,
    write: async (relativePath, content) => {
      const path = join(root, relativePath);
      await mkdir(join(path, '..'), { recursive: true });
      return writeFile(path, content, { flag: 'wx' });
    },
    read: async (relativePath) => readFile(join(root, relativePath), 'utf8'),
  };
  const catalog: ToolBuilderCatalog = { search: vi.fn(async () => []) };
  const executor = {
    run: vi.fn(async () => ({ passed: true, summary: '4 tests passed', output: 'ok' })),
  };
  const service = new ToolBuilderService({
    catalog,
    allocateWorkspace: vi.fn(async () => ws),
    executor,
  });

  const result = await service.propose({
    request: 'Count rows in a CSV file',
    custom: customRequest,
  });

  expect(result).toMatchObject({
    kind: 'draft',
    draft: {
      version: 1,
      status: 'unpublished',
      workspaceId: 'authorized-workspace',
      inputSchema: customRequest.inputSchema,
      examples: customRequest.examples,
      permissions: customRequest.permissions,
      compatibility: customRequest.compatibility,
      tests: { passed: true, summary: '4 tests passed' },
    },
  });
  expect(await readFile(join(root, 'src/index.ts'), 'utf8')).toBe(customRequest.files[0].content);
  expect(executor.run).toHaveBeenCalledWith({
    workspace: ws,
    profile: 'unit',
    signal: expect.any(AbortSignal),
  });
  expect(result).not.toHaveProperty('publication');
});

it.each([
  [
    'failed test',
    async (ws: ToolBuilderWorkspace) => ({ passed: false, summary: '1 test failed' }),
  ],
  [
    'incomplete test run',
    async (ws: ToolBuilderWorkspace) => ({ passed: true, complete: false, summary: 'interrupted' }),
  ],
])('does not create a draft after a %s', async (_label, run) => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: { run: vi.fn(run) },
  });

  await expect(
    service.propose({ request: 'Build a CSV row counter', custom: customRequest }),
  ).rejects.toThrow('Tool draft tests did not complete successfully');
  expect(service.getDraft('missing')).toBeNull();
});

it('stops draft preparation when the user cancels the operation', async () => {
  const ws = await workspace();
  const controller = new AbortController();
  const executor = {
    run: vi.fn(async () => {
      controller.abort();
      return { passed: true, summary: 'completed' };
    }),
  };
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor,
  });

  await expect(
    service.propose({
      request: 'Build a CSV row counter',
      custom: customRequest,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(executor.run).toHaveBeenCalledOnce();
  expect(service.getDraft('missing')).toBeNull();
});

it('rejects parent traversal before writing outside the authorized workspace', async () => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: { run: vi.fn() },
  });
  const invalid = { ...customRequest, files: [{ path: '../escape.ts', content: 'unsafe' }] };

  await expect(
    service.propose({ request: 'Build a CSV row counter', custom: invalid }),
  ).rejects.toThrow();
  expect(await readFile(join(ws.root, 'src/index.ts'), 'utf8').catch(() => null)).toBeNull();
});
