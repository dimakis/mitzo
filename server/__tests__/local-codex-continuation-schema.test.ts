import { expect, it } from 'vitest';
import { LocalCodexContinuationCommandSchema, LocalCodexFirstCommandSchema } from '@mitzo/protocol';
const input = {
  runOn: 'local',
  repositoryWorkspaceId: 'cf414b54-96b4-42e7-bda4-74c55ad94ddf',
  sessionId: 'bound-conversation',
  clientMsgId: 'next-message',
  capabilityRevision: 'capability',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'account' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'published', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: 'offline-model',
    thinking: null,
  },
  payload: { text: 'Continue' },
};
it('keeps first entry strict and requires an explicit retained conversation for future commands', () => {
  expect(LocalCodexFirstCommandSchema.safeParse(input).success).toBe(false);
  expect(LocalCodexContinuationCommandSchema.parse(input)).toEqual(input);
  const { sessionId: _session, ...missing } = input;
  void _session;
  expect(LocalCodexContinuationCommandSchema.safeParse(missing).success).toBe(false);
});
it.each(['cwd', 'systemPrompt', 'auth', 'executablePath'])(
  'refuses caller %s at the continuation boundary',
  (key) => {
    expect(
      LocalCodexContinuationCommandSchema.safeParse({ ...input, [key]: 'private' }).success,
    ).toBe(false);
  },
);
it('bounds the complete future command and preserves permission consistency', () => {
  expect(
    LocalCodexContinuationCommandSchema.safeParse({
      ...input,
      payload: { text: 'a'.repeat(1048576) },
    }).success,
  ).toBe(false);
  expect(
    LocalCodexContinuationCommandSchema.safeParse({
      ...input,
      runtime: { ...input.runtime, mode: 'ask' },
    }).success,
  ).toBe(false);
});

it('supports explicit API billing on local and OpenShell Codex while retaining continuation boundaries', async () => {
  const { OrdinaryCodexFirstCommandSchema, OrdinaryCodexContinuationCommandSchema } =
    await import('@mitzo/protocol');
  const { sessionId: _session, ...first } = input;
  void _session;
  expect(
    OrdinaryCodexFirstCommandSchema.parse({
      ...first,
      runOn: 'openshell',
      runtime: { ...first.runtime, account: { ...first.runtime.account, provider: 'openai' } },
    }).runOn,
  ).toBe('openshell');
  const api = { accountId: 'work-api', provider: 'openai', profileRevision: 'work-revision' };
  const local = { ...first, runtime: { ...first.runtime, account: api } };
  expect(LocalCodexFirstCommandSchema.parse(local).runtime.account).toEqual(api);
  expect(OrdinaryCodexFirstCommandSchema.parse(local).runtime.account).toEqual(api);
  expect(
    LocalCodexContinuationCommandSchema.parse({ ...local, sessionId: input.sessionId }).runtime
      .account,
  ).toEqual(api);
  const { repositoryWorkspaceId: _repository, ...withoutSource } = local;
  void _repository;
  expect(OrdinaryCodexFirstCommandSchema.safeParse(withoutSource).success).toBe(true);
  expect(
    OrdinaryCodexFirstCommandSchema.safeParse({ ...withoutSource, runOn: 'openshell' }).success,
  ).toBe(true);
  expect(
    OrdinaryCodexContinuationCommandSchema.safeParse({
      ...withoutSource,
      runOn: 'openshell',
      sessionId: input.sessionId,
    }).success,
  ).toBe(false);
  expect(
    LocalCodexContinuationCommandSchema.safeParse({ ...withoutSource, sessionId: input.sessionId })
      .success,
  ).toBe(false);
  expect(
    LocalCodexFirstCommandSchema.safeParse({
      ...local,
      runtime: { ...local.runtime, account: { ...api, provider: 'google-vertex' } },
    }).success,
  ).toBe(false);
  expect(
    OrdinaryCodexContinuationCommandSchema.parse({ ...input, runOn: 'openshell' }).sessionId,
  ).toBe(input.sessionId);
});
