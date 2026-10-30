import { afterEach, expect, it, vi } from 'vitest';
import { authenticateToken, login, revokeAuthSession, type AuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
const f = vi.hoisted(() => ({
  live: undefined as unknown,
  custody: { authSessionId: 'original-login', binding: undefined as unknown },
  running: false,
  resume: vi.fn(),
}));
const binding = { harness: { implementation: 'codex' }, execution: { location: 'openshell' } };
vi.mock('../chat.js', () => ({
  eventStore: {
    observeSessionOwnership: () => ({ session: { accountBinding: {} }, runtimeBinding: binding }),
  },
  registry: { findBySessionId: () => f.live },
  prepareOwnedCodexChat: vi.fn(),
  echoOwnedCodexCommand: vi.fn(),
  resolveOwnedTelosWorkCommandScope: vi.fn(),
}));
vi.mock('../codex-chat-session.js', () => ({
  getCodexConversationStore: () => ({
    readOpenShellCustody: () => f.custody,
    read: () => ({ threadId: 'original-thread' }),
    hasRunningCommand: () => f.running,
  }),
  getCodexRuntime: () => ({ resumeAfterExplicitSend: f.resume }),
}));
vi.mock('../ordinary-openshell-codex-entry-owner.js', () => ({
  createOrdinaryOpenShellCodexEntryOwner: vi.fn(),
}));
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerMode: false,
  custodianOwnerMode: false,
  custodianControllerClient: undefined,
}));
import {
  canResumeOwnedOpenShellCodexDriver,
  sendOwnedOpenShellCodexCommand,
} from '../ordinary-openshell-codex-entry.js';
const actors: AuthSession[] = [];
const releases: Array<() => void> = [];
async function actor() {
  const auth = await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!);
  if (!auth) throw Error('Fixture login failed');
  actors.push(auth);
  releases.push(bindAgentLibraryTransport('new-device', auth));
  return auth;
}
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  actors.splice(0).forEach(revokeAuthSession);
  f.live = undefined;
  f.running = false;
  f.resume.mockReset();
  vi.unstubAllEnvs();
});
it('allows cold resume by the verified operator while retaining native binding and running-command checks', async () => {
  const auth = await actor();
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  f.custody = { authSessionId: 'original-login', binding };
  expect(canResumeOwnedOpenShellCodexDriver('chat', auth.id)).toBe(true);
  f.running = true;
  expect(canResumeOwnedOpenShellCodexDriver('chat', auth.id)).toBe(false);
  f.running = false;
  f.custody.binding = { ...binding, execution: { location: 'local' } };
  expect(canResumeOwnedOpenShellCodexDriver('chat', auth.id)).toBe(false);
  f.custody.binding = binding;
  revokeAuthSession(auth);
  expect(canResumeOwnedOpenShellCodexDriver('chat', auth.id)).toBe(false);
  expect(canResumeOwnedOpenShellCodexDriver('chat', 'unverified')).toBe(false);
});
it.each([false, true])(
  'bounds a second-device explicit send by its own authorization (revoked while queued: %s)',
  async (revoke) => {
    const auth = await actor();
    const admit = vi.fn(async (_command, signal: AbortSignal) => {
      if (revoke) revokeAuthSession(auth);
      signal.throwIfAborted();
      return { dispatched: true };
    });
    const original = { location: 'openshell', authSessionId: 'original-login', admit };
    f.live = {
      session: { ordinaryRuntimeOwner: original, ownedLocalAuthSessionId: 'original-login' },
    };
    const result = sendOwnedOpenShellCodexCommand({
      sessionId: 'chat',
      command: { text: 'next' },
      operatorConnectionId: 'new-device',
    });
    if (revoke) {
      await expect(result).rejects.toThrow();
      expect(f.resume).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toMatchObject({ dispatched: true });
      expect(f.resume).toHaveBeenCalledOnce();
    }
    expect(admit).toHaveBeenCalledOnce();
    expect(original.authSessionId).toBe('original-login');
  },
);
