import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { login, authenticateToken, setAuthRevocationStore, revokeAuthSession } from '../auth.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { retainNativeHostToolOperator } from '../native-host-tool-context.js';
import { localRepositoryNativeToolFixture } from './fixtures/local-repository-native-tools.js';

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
