import { expect, it, vi } from 'vitest';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { sessionGoogleWorkspaceTools } from '../session-google-workspace-tools.js';
const { runtime, decide } = vi.hoisted(() => ({
  runtime: { googleWorkspace: { prepareRead: vi.fn() } },
  decide: vi.fn(),
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => runtime }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => decide,
}));

it('reuses Google file consent across read operations and fences delivery on revocation', async () => {
  const f = capabilityFixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: {
      kind: 'google-read',
      email: 'me@example.test',
      resource: { kind: 'file', id: 'doc' },
    },
    durationMinutes: 60,
  });
  let revoke = false;
  const read = vi.fn(async (guard: () => Promise<void>) => {
    await guard();
    if (revoke) await f.grants.revoke('operator', 'one', grant.id);
    await guard();
    return 'private document';
  });
  runtime.googleWorkspace.prepareRead.mockResolvedValue({ email: 'me@example.test', read });
  decide.mockImplementation(async (_name, input) => ({
    behavior: 'deny',
    updatedInput: input,
    message: 'Denied',
  }));
  const tools = sessionGoogleWorkspaceTools({
    sessionId: 'one',
    session: f.session,
    registry: f.registry,
    assertCurrent: async () => {},
    assertCurrentSync() {},
  });
  for (const input of [
    { operation: 'drive.export', fileId: 'doc' },
    { operation: 'docs.get', documentId: 'doc' },
  ]) {
    const result = await tools.execute(input, new AbortController().signal);
    expect(result).toEqual({ content: 'private document', isError: false });
  }
  expect(decide).not.toHaveBeenCalled();
  expect(
    (
      await tools.execute(
        { operation: 'docs.get', documentId: 'different' },
        new AbortController().signal,
      )
    ).isError,
  ).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
  revoke = true;
  const result = await tools.execute(
    { operation: 'docs.get', documentId: 'doc' },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('private document');
});

function readTools(f: ReturnType<typeof capabilityFixture>) {
  return sessionGoogleWorkspaceTools({
    sessionId: 'one',
    session: f.session,
    registry: f.registry,
    assertCurrent: async () => {},
    assertCurrentSync() {},
  });
}

/** Emulates the harness: a retained session key is reused, otherwise the user is prompted. */
function decideLikeHarness(f: ReturnType<typeof capabilityFixture>, answer: 'once' | 'session') {
  let prompts = 0;
  decide.mockReset();
  decide.mockImplementation(async (_name, input, opts) => {
    if (f.session.sessionAllowList.has(opts.sessionGrantKey))
      return { behavior: 'allow', updatedInput: input, decisionClassification: 'user_permanent' };
    prompts++;
    if (answer === 'session') f.session.sessionAllowList.add(opts.sessionGrantKey);
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionClassification: answer === 'session' ? 'user_permanent' : 'user_temporary',
    };
  });
  return () => prompts;
}

it('reads without a prompt in Auto and fences delivery when the mode is lowered', async () => {
  const f = capabilityFixture();
  f.session.mode = 'auto';
  let lower = false;
  runtime.googleWorkspace.prepareRead.mockResolvedValue({
    email: 'me@example.test',
    read: async (guard: () => Promise<void>) => {
      if (lower) f.session.mode = 'agent';
      await guard();
      return 'private document';
    },
  });
  decide.mockReset();
  const tools = readTools(f);
  for (const input of [
    { operation: 'drive.list' },
    { operation: 'docs.get', documentId: 'a' },
    { operation: 'calendar.list' },
  ])
    expect(await tools.execute(input, new AbortController().signal)).toEqual({
      content: 'private document',
      isError: false,
    });
  expect(decide).not.toHaveBeenCalled();
  lower = true;
  const result = await tools.execute(
    { operation: 'docs.get', documentId: 'a' },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('private document');
});

it('asks once per chat and Google account in Agent, offering a session grant', async () => {
  const f = capabilityFixture();
  let email = 'me@example.test';
  runtime.googleWorkspace.prepareRead.mockImplementation(async () => ({
    email,
    read: async (guard: () => Promise<void>) => {
      await guard();
      return 'private document';
    },
  }));
  const prompts = decideLikeHarness(f, 'session');
  const tools = readTools(f);
  for (const input of [
    { operation: 'docs.get', documentId: 'a' },
    { operation: 'sheets.get', spreadsheetId: 'b' },
    { operation: 'drive.list' },
  ])
    expect((await tools.execute(input, new AbortController().signal)).isError).toBe(false);
  expect(prompts()).toBe(1);
  expect(decide.mock.calls[0]![2]).toMatchObject({
    forcePrompt: true,
    allowSessionGrant: true,
    approvalScope: 'session',
    sessionGrantKey: expect.stringMatching(/^google-read-v1:/),
    sessionGrantDescription: expect.stringContaining('me@example.test'),
  });
  email = 'other@example.test';
  await tools.execute({ operation: 'drive.list' }, new AbortController().signal);
  expect(prompts()).toBe(2);
});

it('prompts again after Allow once and fences delivery when a session grant is removed', async () => {
  const f = capabilityFixture();
  let removeGrant = false;
  runtime.googleWorkspace.prepareRead.mockResolvedValue({
    email: 'me@example.test',
    read: async (guard: () => Promise<void>) => {
      if (removeGrant) f.session.sessionAllowList.clear();
      await guard();
      return 'private document';
    },
  });
  const onceTools = readTools(f);
  const oncePrompts = decideLikeHarness(f, 'once');
  await onceTools.execute({ operation: 'drive.list' }, new AbortController().signal);
  await onceTools.execute({ operation: 'drive.list' }, new AbortController().signal);
  expect(oncePrompts()).toBe(2);

  decideLikeHarness(f, 'session');
  removeGrant = true;
  const result = await onceTools.execute({ operation: 'drive.list' }, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('private document');
});
