import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { login, authenticateToken, setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { retainNativeHostToolOperator } from '../native-host-tool-context.js';
import { localRepositoryNativeToolFixture } from './fixtures/local-repository-native-tools.js';

vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async () => {},
    resolveKey: async () => 'synthetic-api-key',
  }),
}));

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.runIf(process.platform === 'darwin').each([false, true])(
  'keeps native tools available after cold resume by a new signed login (API=%s)',
  async (api) => {
    const execute = vi.fn(async () => ({ content: '{}', isError: false }));
    const f = await localRepositoryNativeToolFixture(cleanups, execute, {
      api,
      separateViewer: true,
      resumeFromPreviousLogin: true,
    });
    const custody = f.native.readHostCustody(f.a.sessionId, f.a.initial.lease.binding)!;
    expect(custody.authSessionId).not.toBe(f.auth.id);
    expect(() => f.a.initial.admission.assertCurrentSync()).not.toThrow();
    f.detachViewer();
    const result = await f.a.call({ query: 'after-login' });
    expect(result.response.success, JSON.stringify(result.value)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.native.readHostCustody(f.a.sessionId, f.a.initial.lease.binding)).toEqual(custody);
    revokeAuthSession(f.auth);
    expect((await f.a.call({ query: 'after-revocation' })).response.success).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  },
  // Real filesystem/SQLite setup plus two cold admissions exceeded Vitest's
  // default 5s on hosted macOS. Native operation and expiry bounds stay intact.
  15000,
);

it.runIf(process.platform === 'darwin')(
  'keeps an already captured native operation current when its viewer disconnects',
  async () => {
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async (context) => {
        context.assertCurrentSync();
        f.detachViewer();
        await context.assertCurrent();
        expect(context.signal.aborted).toBe(false);
        return { content: '{}', isError: false };
      },
      { separateViewer: true },
    );
    expect((await f.a.call({ query: 'in-flight' })).response.success).toBe(true);
  },
);

it.runIf(process.platform === 'darwin')(
  'never falls back to a connected viewer after the retained native operator is released',
  async () => {
    const execute = vi.fn(async () => ({ content: '{}', isError: false }));
    const f = await localRepositoryNativeToolFixture(cleanups, execute, { separateViewer: true });
    expect((await f.a.call({ query: 'fixture' })).response.success).toBe(true);
    f.a.releaseNativeOperator();
    const refused = await f.a.call({ query: 'after-release' });
    expect(refused.response.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() => f.a.initial.admission.assertCurrentSync()).not.toThrow();
  },
);

it.runIf(process.platform === 'darwin')(
  'requires the admitted subject and refuses duplicate native operator selection',
  async () => {
    const f = await localRepositoryNativeToolFixture(
      cleanups,
      async () => ({ content: '{}', isError: false }),
      { separateViewer: true },
    );
    const auth = (await authenticateToken((await login(process.env.AUTH_PASSPHRASE!))!))!;
    cleanups.push(bindAgentLibraryTransport('other-operator', auth));
    expect(auth.id).not.toBe(f.auth.id);
    expect(() => retainNativeHostToolOperator(f.a.session, 'other-operator')).toThrow();
    expect(() =>
      retainNativeHostToolOperator(f.a.session, f.f.dependencies.operatorConnectionId),
    ).toThrow();
    expect((await f.a.call({ query: 'original' })).response.success).toBe(true);
  },
);

it.runIf(process.platform === 'darwin').each(['logout', 'expiry'] as const)(
  'keeps %s effective after the viewer disconnects',
  async (reason) => {
    const execute = vi.fn(async () => ({ content: '{}', isError: false }));
    const f = await localRepositoryNativeToolFixture(cleanups, execute, { separateViewer: true });
    f.detachViewer();
    expect((await f.a.call({ query: 'before-logout' })).response.success).toBe(true);
    if (reason === 'logout') revokeAuthSession(f.auth);
    else {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(f.auth.expiresAt + 1);
    }
    const refused = await f.a.call({ query: 'after-logout' });
    expect(refused.response.success).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  },
);
