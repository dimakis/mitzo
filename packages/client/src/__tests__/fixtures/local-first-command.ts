export const localFirstCommandFixture = {
  runOn: 'local',
  repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
  clientMsgId: 'local-first',
  capabilityRevision: 'caps-r1',
  runtime: {
    account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'routing-r1' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  },
  selection: {
    version: 1,
    agent: { profileId: 'agent', revision: 1 },
    model: 'luna-fixture',
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'inspect' },
};
