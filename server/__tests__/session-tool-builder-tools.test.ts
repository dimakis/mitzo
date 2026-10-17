import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry, type buildPermissionHandler } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { sessionToolBuilderTools } from '../session-tool-builder-tools.js';
import { toolBuilderToolDefinitions } from '../tool-builder-tool-definitions.js';
import { toolBuilderFixture as fixture } from './fixtures/tool-builder.js';
import {
  CustomToolDraftInputSchema,
  type ToolBuilderCatalog,
  type ToolBuilderExecutor,
} from '../tool-builder.js';
import { createToolBuilderWorkspace } from '../tool-builder-workspace.js';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function sessionFixture() {
  const f = fixture();
  cleanup.push(() => f.store.close());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-builder-session-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
  cleanup.push(bindAgentLibraryTransport('client', auth));
  registry.register('client', {
    sessionId: 'builder',
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    cwd: root,
    sessionAllowList: new Set(),
  });
  const session = registry.get('client')!;
  session.worktreePaths.set('primary', { path: root, wtId: 'test' });
  bindAgentToolSelection(session, {
    name: 'Builder',
    role: 'agent',
    instructions: 'Prepare drafts',
    expectedOutput: 'Draft',
    acceptanceCriteria: ['Review'],
    modelPolicyRole: 'agent',
    tools: toolBuilderToolDefinitions.map((tool) => ({ id: `mitzo:${tool.name}`, version: 1 })),
  });
  const custom = CustomToolDraftInputSchema.strip().parse(f.draft);
  const allocateWorkspace = vi.fn(createToolBuilderWorkspace);
  const approve = vi.fn<ReturnType<typeof buildPermissionHandler>>(async (_name, input) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  const catalog = {
    search: vi.fn<ToolBuilderCatalog['search']>(async () => []),
    readContract: vi.fn(async () => ({})),
  };
  const executor = {
    run: vi.fn<ToolBuilderExecutor['run']>(async () => ({
      passed: true,
      complete: true,
      evidenceKind: 'trusted-executor' as const,
      summary: 'Synthetic executor checks passed',
      examples: custom.examples.map((example) => ({ passed: true, actual: example.expected })),
    })),
  };
  const options = {
    store: f.store,
    catalog,
    executor,
    allocateWorkspace,
    approve,
    privateRoots: () => [],
  };
  const tools = sessionToolBuilderTools('builder', session, registry, options);
  return {
    ...f,
    registry,
    auth,
    session,
    custom,
    approve,
    catalog,
    executor,
    allocateWorkspace,
    tools,
    options,
  };
}
const identity = (callId: string) => ({ turnId: 'turn', callId });
const result = (value: { content: string; isError: boolean } | undefined) => {
  expect(value?.isError).toBe(false);
  return JSON.parse(value!.content);
};

it('uses nonrecursive provider schemas while retaining strict server-side draft validation', () => {
  for (const definition of toolBuilderToolDefinitions)
    expect(JSON.stringify(definition.input_schema)).not.toContain('"$ref"');
});

it('proposes actual catalog reuse before any development approval, workspace or implementation', async () => {
  const f = await sessionFixture();
  f.catalog.search.mockResolvedValueOnce([
    {
      id: 'mitzo:Read',
      version: 1,
      name: 'Read',
      description: 'Existing equivalent',
      equivalent: true,
    },
  ]);
  const value = result(
    await f.tools.execute(
      'ToolBuilderPrepareDraft',
      { request: 'Read a file' },
      new AbortController().signal,
      identity('reuse'),
    ),
  );
  expect(value).toMatchObject({ kind: 'reuse', tool: { id: 'mitzo:Read', version: 1 } });
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.allocateWorkspace).not.toHaveBeenCalled();
  expect(f.executor.run).not.toHaveBeenCalled();
  expect(f.store.list('user')).toEqual([]);
});

it('does not add Builder capabilities to legacy sessions and refuses private workspace overlap', async () => {
  const f = await sessionFixture();
  const legacy = { ...f.session };
  expect(sessionToolBuilderTools('builder', legacy, f.registry, f.options).definitions).toEqual([]);
  const privateRoot = f.session.worktreePaths.get('primary')!.path;
  const tools = sessionToolBuilderTools('builder', f.session, f.registry, {
    ...f.options,
    privateRoots: () => [join(privateRoot, 'private')],
  });
  expect(
    (
      await tools.execute(
        'ToolBuilderPrepareDraft',
        { request: 'Count', custom: f.custom },
        new AbortController().signal,
        identity('private'),
      )
    )?.isError,
  ).toBe(true);
  expect(f.approve).not.toHaveBeenCalled();
  expect(f.allocateWorkspace).not.toHaveBeenCalled();
});

it('coalesces identical in-flight calls and refuses changed retry input', async () => {
  const f = await sessionFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.executor.run.getMockImplementation()!;
  f.executor.run.mockImplementationOnce(async (input) => {
    await gate;
    return original(input);
  });
  const body = { request: 'Count characters', custom: f.custom };
  const signal = new AbortController().signal;
  const first = f.tools.execute('ToolBuilderPrepareDraft', body, signal, identity('duplicate'));
  await vi.waitFor(() => expect(f.executor.run).toHaveBeenCalledOnce(), { timeout: 5000 });
  const second = f.tools.execute('ToolBuilderPrepareDraft', body, signal, identity('duplicate'));
  expect(
    (
      await f.tools.execute(
        'ToolBuilderPrepareDraft',
        { ...body, request: 'Different' },
        signal,
        identity('duplicate'),
      )
    )?.isError,
  ).toBe(true);
  release();
  const value = await first;
  expect(await second).toEqual(value);
  expect(f.allocateWorkspace).toHaveBeenCalledOnce();
  expect(
    (
      await f.tools.execute(
        'ToolBuilderPrepareDraft',
        { ...body, request: 'Different' },
        signal,
        identity('duplicate'),
      )
    )?.isError,
  ).toBe(true);
  expect(f.store.list('user')).toHaveLength(1);
}, 15000);

it('requires independent operator acceptance and installed source before publishing a generated draft; assignment stays separate', async () => {
  const f = await sessionFixture();
  const signal = new AbortController().signal;
  const prepared = result(
    await f.tools.execute(
      'ToolBuilderPrepareDraft',
      { request: 'Count characters', custom: f.custom },
      signal,
      identity('acceptance'),
    ),
  );
  const draft = f.store.read('user', prepared.draft.id)!.draft;
  await expect(f.store.publish('user', draft.id, 1, draft.contractDigest)).rejects.toThrow();
  result(
    await f.tools.execute(
      'ToolBuilderSubmitReview',
      { id: draft.id, version: 1, contractDigest: draft.contractDigest },
      signal,
      identity('submit-acceptance'),
    ),
  );
  f.store.review(
    'user',
    draft.id,
    1,
    { decision: 'accepted', feedback: '', contractDigest: draft.contractDigest },
    'user',
  );
  await expect(f.store.publish('user', draft.id, 1, draft.contractDigest)).rejects.toThrow(
    'not installed',
  );
  expect(f.store.listTools('user')).toEqual([]);
  f.installDraft(draft); // Synthetic accepted application-source installation, never a tool input.
  const publication = await f.store.publish('user', draft.id, 1, draft.contractDigest);
  expect(f.store.listTools('user')).toEqual([publication.entry]);
  expect(
    f.tools.definitions.some((tool) => tool.name === publication.binding.definition.name),
  ).toBe(false);
  expect(
    await f.tools.execute(
      publication.binding.definition.name,
      { text: 'abc' },
      signal,
      identity('unassigned'),
    ),
  ).toBeUndefined();
});

it('discards tested source if immutable draft persistence fails', async () => {
  const f = await sessionFixture();
  vi.spyOn(f.store, 'save').mockImplementationOnce(() => {
    throw Error('Version conflict');
  });
  const value = await f.tools.execute(
    'ToolBuilderPrepareDraft',
    { request: 'Count characters', custom: f.custom },
    new AbortController().signal,
    identity('failed-save'),
  );
  expect(value?.isError).toBe(true);
  const workspace = await f.allocateWorkspace.mock.results[0].value;
  await expect(stat(workspace.root)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.store.list('user')).toEqual([]);
});

it('refuses replacement of the approved worktree during awaited approval', async () => {
  const f = await sessionFixture();
  const root = f.session.worktreePaths.get('primary')!.path;
  const moved = root + '-retained';
  cleanup.push(() => rm(moved, { recursive: true, force: true }));
  f.approve.mockImplementationOnce(async (_name, input) => {
    await rename(root, moved);
    await mkdir(root);
    return { behavior: 'allow', updatedInput: input };
  });
  expect(
    (
      await f.tools.execute(
        'ToolBuilderPrepareDraft',
        { request: 'Count characters', custom: f.custom },
        new AbortController().signal,
        identity('replace-root'),
      )
    )?.isError,
  ).toBe(true);
  expect(f.allocateWorkspace).not.toHaveBeenCalled();
  expect(f.store.list('user')).toEqual([]);
});

it('prepares a useful unpublished draft, retries exactly and incorporates independent feedback into a new version', async () => {
  const f = await sessionFixture();
  const signal = new AbortController().signal;
  const body = { request: 'Count text characters', custom: f.custom };
  const initial = result(
    await f.tools.execute('ToolBuilderPrepareDraft', body, signal, identity('prepare')),
  );
  expect(initial).toMatchObject({
    kind: 'draft',
    draft: { version: 1, status: 'unpublished', tests: { passed: true, complete: true } },
  });
  expect(f.store.listTools('user')).toEqual([]);
  expect(
    await f.tools.execute('ToolBuilderPrepareDraft', body, signal, identity('prepare')),
  ).toEqual({ content: JSON.stringify(initial), isError: false });
  expect(f.executor.run).toHaveBeenCalledOnce();
  const stored = f.store.read('user', initial.draft.id, 1)!;
  expect(stored.draft.files).toEqual(f.custom.files);
  expect(stored.sessionId).toBe('builder');
  result(
    await f.tools.execute(
      'ToolBuilderSubmitReview',
      { id: stored.draft.id, version: 1, contractDigest: stored.draft.contractDigest },
      signal,
      identity('submit'),
    ),
  );
  f.store.review(
    'user',
    stored.draft.id,
    1,
    {
      decision: 'rejected',
      feedback: 'Clarify the output description',
      contractDigest: stored.draft.contractDigest,
    },
    'operator',
  );
  const revised = result(
    await f.tools.execute(
      'ToolBuilderReviseDraft',
      {
        id: stored.draft.id,
        expectedVersion: 1,
        request: body.request,
        feedback: 'Clarify the output description',
        custom: { ...f.custom, description: 'Return text length as an integer.' },
      },
      signal,
      identity('revise'),
    ),
  );
  expect(revised.draft.id).toBe(stored.draft.id);
  expect(revised.draft.version).toBe(2);
  expect(revised.draft.status).toBe('unpublished');
  expect(f.store.read('user', stored.draft.id, 1)?.review?.decision).toBe('rejected');
  expect(f.store.listTools('user')).toEqual([]);
  expect(
    await f.tools.execute(
      'ToolBuilderPublish',
      { id: stored.draft.id },
      signal,
      identity('publish'),
    ),
  ).toBeUndefined();
  expect(
    await f.tools.execute(
      'ToolBuilderReview',
      { decision: 'accepted' },
      signal,
      identity('approve'),
    ),
  ).toBeUndefined();
});

it.each(['deny', 'revoke', 'cancel', 'ask', 'unsupported-workspace', 'failed-tests'] as const)(
  'does not retain a draft or broaden authority after %s',
  async (action) => {
    const f = await sessionFixture();
    const controller = new AbortController();
    if (action === 'deny')
      f.approve.mockImplementationOnce(async () => ({ behavior: 'deny', message: 'Denied' }));
    if (action === 'revoke')
      f.approve.mockImplementationOnce(async (_name, input) => {
        revokeAuthSession(f.auth);
        return { behavior: 'allow', updatedInput: input };
      });
    if (action === 'cancel')
      f.executor.run.mockImplementationOnce(async () => {
        controller.abort();
        return {
          passed: true,
          complete: true,
          evidenceKind: 'trusted-executor',
          summary: 'Cancelled',
          examples: [],
        };
      });
    if (action === 'ask') f.session.mode = 'ask';
    if (action === 'unsupported-workspace') f.session.worktreePaths.clear();
    if (action === 'failed-tests')
      f.executor.run.mockImplementationOnce(async () => ({
        passed: false,
        complete: true,
        evidenceKind: 'trusted-executor',
        summary: 'Failed',
        examples: [],
      }));
    const value = await f.tools.execute(
      'ToolBuilderPrepareDraft',
      { request: 'Count characters', custom: f.custom },
      controller.signal,
      identity('blocked'),
    );
    expect(value?.isError).toBe(true);
    expect(f.store.list('user')).toEqual([]);
    expect(f.store.listTools('user')).toEqual([]);
    if (['deny', 'revoke', 'ask', 'unsupported-workspace'].includes(action))
      expect(f.allocateWorkspace).not.toHaveBeenCalled();
  },
);
