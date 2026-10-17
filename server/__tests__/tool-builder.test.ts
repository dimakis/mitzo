import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ToolBuilderService,
  type ToolBuilderCatalog,
  type ToolBuilderWorkspace,
} from '../tool-builder.js';
import { ToolBuilderStore } from '../tool-builder-store.js';

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
    { path: 'src/index.mjs', content: 'export function runTool(input) { return { count: 2 }; }\n' },
    {
      path: 'test/row-count.test.mjs',
      content: "import test from 'node:test';\ntest('rows', () => {});\n",
    },
  ],
  testProfile: 'unit',
};
const successfulTest = {
  passed: true,
  complete: true,
  summary: '4 tests passed',
  output: 'ok',
  examples: [{ passed: true, actual: { count: 2 } }],
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
  expect(await readFile(join(root, 'src/index.mjs'), 'utf8')).toBe(customRequest.files[0].content);
  expect(executor.run).toHaveBeenCalledWith({
    workspace: ws,
    profile: 'unit',
    signal: expect.any(AbortSignal),
    examples: customRequest.examples,
  });
  expect(result).not.toHaveProperty('publication');
});

it.each([
  [
    'failed test',
    async (_ws: ToolBuilderWorkspace) => ({ passed: false, summary: '1 test failed' }),
  ],
  [
    'incomplete test run',
    async (_ws: ToolBuilderWorkspace) => ({
      passed: true,
      complete: false,
      summary: 'interrupted',
    }),
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
        await writeFile(join(ws.root, 'src/index.mjs'), 'changed during test run');
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
  expect(await readFile(join(ws.root, 'src/index.mjs'), 'utf8').catch(() => null)).toBeNull();
});

it('retests a new source version after review feedback and preserves the rejected version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-revision-'));
  roots.push(root);
  const store = new ToolBuilderStore(join(root, 'builder.db'));
  const allocateWorkspace = vi.fn(workspace);
  const service = new ToolBuilderService({
    catalog: { search: vi.fn(async () => []) },
    allocateWorkspace,
    executor: {
      run: vi.fn(async ({ workspace: target }) => {
        const source = await target.read('src/index.mjs');
        return {
          passed: true,
          complete: true,
          summary: 'tests passed',
          examples: [
            { passed: true, actual: { count: 2 } },
            ...(source.includes('empty-case') ? [{ passed: true, actual: { count: 0 } }] : []),
          ],
        };
      }),
    },
    store,
    authorId: 'session-author',
  });
  const proposed = await service.propose({ request: 'Count rows in CSV', custom: customRequest });
  if (proposed.kind !== 'draft') throw Error('Expected a draft');
  const submitted = store.submitForReview(
    proposed.draft.id,
    proposed.draft.version,
    proposed.draft.sourceDigest,
  );
  store.resolveReview({
    draftId: submitted.id,
    version: submitted.version,
    reviewId: 'revision-feedback',
    reviewerId: 'independent-reviewer',
    decision: 'rejected',
    sourceDigest: proposed.draft.sourceDigest,
    feedback: 'Cover an empty file in the examples.',
  });
  const revisedInput = {
    ...customRequest,
    files: [
      { ...customRequest.files[0], content: `${customRequest.files[0].content}// empty-case\n` },
      customRequest.files[1],
    ],
    examples: [...customRequest.examples, { input: { csv: '' }, expected: { count: 0 } }],
  };
  const revised = await service.reviseDraft({
    id: proposed.draft.id,
    expectedVersion: proposed.draft.version,
    feedback: 'Cover an empty file in the examples.',
    custom: revisedInput,
  });

  expect(revised.draft.version).toBe(2);
  expect(revised.draft.toolId).toBe(proposed.draft.toolId);
  expect(revised.draft.examples).toHaveLength(2);
  expect(store.getDraft(proposed.draft.id, 1)?.status).toBe('rejected');
  expect(store.getDraft(proposed.draft.id, 1)?.review?.feedback).toBe(
    'Cover an empty file in the examples.',
  );
  expect(allocateWorkspace).toHaveBeenCalledTimes(2);
  store.close();
});
