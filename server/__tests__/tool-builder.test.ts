import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    snapshot: async () => {
      const paths = await readdir(root, { recursive: true, withFileTypes: true });
      return Promise.all(
        paths
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            const path = join(entry.parentPath, entry.name).slice(root.length + 1);
            return { path, content: await readFile(join(root, path), 'utf8') };
          }),
      );
    },
    discard: async () => rm(root, { recursive: true, force: true }),
  };
}

const customRequest = {
  name: 'CSV row count',
  description: 'Count rows in a CSV file while ignoring the header.',
  inputSchema: {
    type: 'object',
    properties: { csv: { type: 'string' } },
    required: ['csv'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  },
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

it.each([
  [{ input: { csv: 42 }, expected: { count: 2 } }],
  [{ input: { csv: 'name\nAda\nLin' }, expected: { count: 'two' } }],
])(
  'rejects examples outside the declared schemas before allocating or running code',
  async (example) => {
    const allocateWorkspace = vi.fn(workspace);
    const executor = {
      run: vi.fn(async () => ({
        ...successfulTest,
        examples: [{ passed: true, actual: example.expected }],
      })),
    };
    const service = new ToolBuilderService({
      catalog: { search: async () => [] },
      allocateWorkspace,
      executor,
    });
    await expect(
      service.propose({
        request: 'CSV counter',
        custom: { ...customRequest, examples: [example] },
      }),
    ).rejects.toThrow(/schema/i);
    expect(allocateWorkspace).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  },
);

it('rejects unsupported schema references before any workspace or executor effect', async () => {
  const allocateWorkspace = vi.fn(workspace);
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace,
    executor: { run: vi.fn() },
  });
  await expect(
    service.propose({
      request: 'CSV counter',
      custom: { ...customRequest, inputSchema: { $ref: 'https://external.example/schema' } },
    }),
  ).rejects.toThrow(/schema/i);
  expect(allocateWorkspace).not.toHaveBeenCalled();
});
const successfulTest = {
  passed: true,
  complete: true,
  evidenceKind: 'trusted-executor' as const,
  summary: '4 tests passed',
  output: 'ok',
  examples: [{ passed: true, actual: { count: 2 } }],
};
it('rejects a file exceeding the UTF-8 byte limit before allocating development authority', async () => {
  const allocateWorkspace = vi.fn(workspace);
  const run = vi.fn(async () => successfulTest);
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace,
    executor: { run },
  });
  await expect(
    service.propose({
      request: 'CSV counter',
      custom: {
        ...customRequest,
        files: [{ path: 'src/index.mts', content: '//' + 'é'.repeat(128000) }],
      },
    }),
  ).rejects.toThrow(/byte|source/i);
  expect(allocateWorkspace).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

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
  const ws = { ...(await workspace()), id: 'authorized-workspace' };
  const catalog: ToolBuilderCatalog = { search: vi.fn(async () => []) };
  const executor = {
    run: vi.fn(async () => successfulTest),
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
  expect(await readFile(join(ws.root, 'src/index.ts'), 'utf8')).toBe(
    customRequest.files[0].content,
  );
  expect(executor.run).toHaveBeenCalledWith({
    workspace: ws,
    profile: 'unit',
    examples: customRequest.examples,
    signal: expect.any(AbortSignal),
  });
  expect(result).not.toHaveProperty('publication');
});

it('binds evidence to the whole contract and returns independent draft snapshots', async () => {
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace: workspace,
    executor: { run: async () => successfulTest },
  });
  const first = await service.propose({ request: 'CSV counter', custom: customRequest });
  const changed = await service.propose({
    request: 'CSV counter',
    custom: {
      ...customRequest,
      permissions: { behavior: 'write', requiredConnections: [] },
    },
  });
  if (first.kind !== 'draft' || changed.kind !== 'draft') throw Error('Missing draft');
  expect(first.draft.sourceDigest).toBe(changed.draft.sourceDigest);
  expect(first.draft.contractDigest).not.toBe(changed.draft.contractDigest);
  expect(first.draft.tests.contractDigest).toBe(first.draft.contractDigest);
  first.draft.files[0].content = 'mutated';
  first.draft.tests.examples[0].actual.count = 99;
  const retained = service.getDraft(first.draft.id)!;
  expect(retained.files[0].content).toBe(customRequest.files[0].content);
  expect(retained.tests.examples[0].actual).toEqual({ count: 2 });
  retained.name = 'mutated again';
  expect(service.getDraft(first.draft.id)?.name).toBe(customRequest.name);
});

it('rejects files that do not match the requested source and cleans up the workspace', async () => {
  const ws = await workspace();
  const discard = vi.fn(ws.discard);
  const executor = { run: vi.fn(async () => successfulTest) };
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace: async () => ({
      ...ws,
      discard,
      write: async (path) => ws.write(path, 'changed'),
    }),
    executor,
  });
  await expect(service.propose({ request: 'CSV counter', custom: customRequest })).rejects.toThrow(
    'source',
  );
  expect(executor.run).not.toHaveBeenCalled();
  expect(discard).toHaveBeenCalledOnce();
});

it('rejects undeclared files created by a test and discards the failed workspace', async () => {
  const ws = await workspace();
  const discard = vi.fn(ws.discard);
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace: async () => ({ ...ws, discard }),
    executor: {
      run: async () => {
        await ws.write('unreviewed.mjs', 'export const unreviewed = true;');
        return successfulTest;
      },
    },
  });
  await expect(service.propose({ request: 'CSV counter', custom: customRequest })).rejects.toThrow(
    'source',
  );
  expect(discard).toHaveBeenCalledOnce();
});

it('cleans up a workspace allocated while cancellation was pending', async () => {
  const ws = await workspace();
  const discard = vi.fn(ws.discard);
  const controller = new AbortController();
  const service = new ToolBuilderService({
    catalog: { search: async () => [] },
    allocateWorkspace: async () => {
      controller.abort();
      return { ...ws, discard };
    },
    executor: { run: vi.fn() },
  });
  await expect(
    service.propose({ request: 'CSV counter', custom: customRequest, signal: controller.signal }),
  ).rejects.toThrow();
  expect(discard).toHaveBeenCalledOnce();
});

it.each([
  ['failed test', { passed: false, summary: '1 test failed' }],
  ['incomplete test run', { complete: false, summary: 'interrupted' }],
])('does not create a draft after a %s', async (_label, result) => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: { run: vi.fn(async () => ({ ...successfulTest, ...result })) },
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
      return successfulTest;
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

it('does not attach a passing test receipt when a declared example returns the wrong result', async () => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: {
      run: vi.fn(async () => ({
        ...successfulTest,
        examples: [{ passed: true, actual: { count: 3 } }],
      })),
    },
  });

  await expect(
    service.propose({ request: 'Build a CSV row counter', custom: customRequest }),
  ).rejects.toThrow('Tool draft tests did not complete successfully');
});

it('refuses a test receipt if source changes during the test run', async () => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: {
      run: vi.fn(async () => {
        await writeFile(join(ws.root, 'src/index.ts'), 'changed during test run');
        return successfulTest;
      }),
    },
  });

  await expect(
    service.propose({ request: 'Build a CSV row counter', custom: customRequest }),
  ).rejects.toThrow('Tool draft source changed during testing');
});

it('rejects parent traversal before writing outside the authorized workspace', async () => {
  const ws = await workspace();
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace: vi.fn(async () => ws),
    executor: { run: vi.fn(async () => successfulTest) },
  });
  const invalid = { ...customRequest, files: [{ path: '../escape.ts', content: 'unsafe' }] };

  await expect(
    service.propose({ request: 'Build a CSV row counter', custom: invalid }),
  ).rejects.toThrow();
  expect(await readFile(join(ws.root, 'src/index.ts'), 'utf8').catch(() => null)).toBeNull();
});
