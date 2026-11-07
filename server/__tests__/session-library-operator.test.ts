import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SessionRegistry } from '@mitzo/harness';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { retainNativeHostToolOperator } from '../native-host-tool-operator.js';
import { revokeAuthSession } from '../auth.js';
import { sessionProfileTools } from '../session-profile-tools.js';
import { sessionAgentTaskTools } from '../session-agent-task-tools.js';

const owner = vi.hoisted(() => ({
  request: vi.fn(async () => ({ status: 200, body: [] })),
  invalidate: vi.fn(),
}));
vi.mock('../symposium-custodian-mode.js', () => ({ custodianControllerClient: owner }));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.clearAllMocks();
});

it.each([
  ['SymposiumReadProfiles', sessionProfileTools],
  ['AgentReadTasks', sessionAgentTaskTools],
] as const)(
  '%s uses the admitted login across disconnect and remote awaits',
  async (name, create) => {
    const registry = new SessionRegistry();
    cleanup.push(() => registry.dispose());
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    const replacement = { id: randomUUID(), expiresAt: auth.expiresAt };
    registry.register('viewer:chat', {
      sessionId: 'chat',
      mode: 'agent',
      transport: { send() {}, isOpen: () => true },
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      ownerConnectionId: 'viewer',
      ownedLocalAuthSessionId: auth.id,
    });
    const session = registry.get('viewer:chat')!;
    const disconnect = bindAgentLibraryTransport('viewer', auth);
    cleanup.push(disconnect, retainNativeHostToolOperator(session, 'viewer'));
    disconnect();
    cleanup.push(bindAgentLibraryTransport('new-viewer', replacement));
    const tools = create(
      'chat',
      session,
      registry,
      '',
      async () => {},
      () => {},
    );
    owner.request.mockImplementationOnce(async () => {
      session.ownerConnectionId = 'new-viewer';
      return { status: 200, body: [] };
    });
    const signal = new AbortController().signal;
    expect((await tools.execute(name, { action: 'list' }, signal))?.isError).toBe(false);
    expect(owner.request).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.objectContaining({ id: auth.id }) }),
      undefined,
      expect.any(AbortSignal),
    );
    revokeAuthSession(auth);
    expect((await tools.execute(name, { action: 'list' }, signal))?.isError).toBe(true);
    expect(owner.request).toHaveBeenCalledTimes(1);
  },
);
