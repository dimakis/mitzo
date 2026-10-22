import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
const state = vi.hoisted(() => ({
  events: undefined as EventStore | undefined,
  packets: [] as Array<{ payload: { systemPrompt: string } }>,
}));
vi.mock('../chat.js', () => ({
  eventStore: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = (state.events as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(state.events) : value;
      },
    },
  ),
  registry: { findBySessionId: () => undefined },
  prepareOwnedCodexChat: vi.fn(),
  echoOwnedCodexCommand: vi.fn(),
  resolveOwnedTelosWorkCommandScope: vi.fn(() => null),
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: () => ({ auth: { id: 'operator' }, assertCurrent: () => {} }),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexConversationStore: () => ({}),
  getCodexRuntime: () => undefined,
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerMode: false,
  custodianOwnerMode: false,
}));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  createOrdinaryOpenShellCodexEntryOwner: () => ({
    driver: {
      close: () => {},
      admitPreparedFirst: async (
        _id: string,
        _meta: unknown,
        packet: { payload: { systemPrompt: string } },
      ) => {
        state.packets.push(packet);
        return { dispatched: false, sessionId: 'session' };
      },
    },
  }),
}));
import { startOwnedOpenShellCodexCommand } from '../ordinary-openshell-codex-entry.js';
afterEach(() => {
  state.events?.close();
  state.packets = [];
  vi.unstubAllEnvs();
});
it.each([
  { malformed: false, ordinary: false },
  { malformed: true, ordinary: false },
  { malformed: false, ordinary: true },
  { malformed: true, ordinary: true },
])(
  'includes retained host mandate in OpenShell packet and preserves workspace kind: %j',
  async ({ malformed, ordinary }) => {
    vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
    const events = (state.events = new EventStore(':memory:'));
    const binding = {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai-codex' as const,
      model: 'offline-model',
      profileRevision: 'v1',
    };
    const text = 'Reviewed OpenShell item';
    retainTelosWorkRoleContext(events, 'session', binding, {
      version: 1,
      itemId: 'item',
      role: 'lead',
      brief: {
        revision: 'selected',
        text,
        sha256: createHash('sha256').update(text).digest('hex'),
      },
      parentCriteria: [],
      overallGoal: { itemId: 'item', revision: 'selected', text: 'Goal' },
      sources: [],
      artifacts: [],
    });
    if (malformed)
      events.append('session', 'telos_work_role_context', {
        version: 1,
        selection: { role: 'lead' },
      });
    const definition = {
      name: 'Agent',
      descriptor: 'Agent',
      role: 'agent' as const,
      instructions: 'Base agent instructions',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent' as const,
    };
    const result = startOwnedOpenShellCodexCommand({} as never, 'client', {
      command: {
        clientMsgId: 'command',
        capabilityRevision: 'capability',
        runtime: {
          account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'v1' },
          harness: 'codex',
          targetId: 'openshell',
          mode: 'agent',
        },
        selection: {
          version: 1,
          agent: { profileId: 'agent', revision: 1 },
          context: { source: 'none', revision: null },
          permission: { mode: 'agent', revision: 0 },
          model: 'offline-model',
          thinking: null,
        },
        payload: { text: 'Explicit command' },
      },
      meta: {
        sessionId: 'session',
        accountBinding: binding,
        ...(ordinary
          ? { ordinaryWorkspaceId: 'workspace' }
          : { repositoryWorkspaceId: 'workspace' }),
        agentProfile: {
          profileId: 'agent',
          revision: 1,
          definition,
          contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        },
      },
      taskRoot: '/offline/task',
      operatorConnectionId: 'operator',
      ownerConnectionId: 'viewer',
      signal: new AbortController().signal,
      preparationOperationId: 'preparation',
    });
    if (malformed) {
      await expect(result).rejects.toThrow();
      expect(state.packets).toHaveLength(0);
      return;
    }
    await result;
    expect(state.packets[0].payload.systemPrompt).toContain(
      'Child execution requires a separate worker conversation',
    );
    expect(state.packets[0].payload.systemPrompt).toContain(text);
  },
);
