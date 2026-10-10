import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  invalidate: vi.fn(),
  revoked: (() => {}) as () => void,
}));
vi.mock('../auth.js', () => ({
  registerAuthSession: (_auth: unknown, onRevoked: () => void) => {
    mocks.revoked = onRevoked;
    return () => {};
  },
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: { request: mocks.request, invalidate: mocks.invalidate },
}));
import {
  bindAgentLibraryTransport,
  readAgentLibraryProfile,
  captureAgentLibraryAuthorization,
  withAgentLibraryRecoveryAuthorization,
} from '../agent-library-transport.js';
const cleanups: (() => void)[] = [];
it('scopes a recovery to its verified login and releases the binding after admission', async () => {
  const auth = { id: 'verified-recovery', expiresAt: Date.now() + 10000 };
  let connectionId: string | undefined;
  await withAgentLibraryRecoveryAuthorization(auth, async (id) => {
    connectionId = id;
    expect(captureAgentLibraryAuthorization(id).auth).toBe(auth);
  });
  expect(() => captureAgentLibraryAuthorization(connectionId)).toThrow(/authentication/);
});
it('refuses expired recovery authorization before invoking startup and detects logout during it', async () => {
  const operation = vi.fn(async () => {});
  await expect(
    withAgentLibraryRecoveryAuthorization({ id: 'expired', expiresAt: Date.now() - 1 }, operation),
  ).rejects.toThrow(/authentication/);
  expect(operation).not.toHaveBeenCalled();
  await withAgentLibraryRecoveryAuthorization(
    { id: 'active', expiresAt: Date.now() + 10000 },
    async (id) => {
      const captured = captureAgentLibraryAuthorization(id);
      mocks.revoked();
      expect(() => captured.assertCurrent()).toThrow(/revoked/);
    },
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.clearAllMocks();
});
it('refuses an unbound or expired transport before reaching either catalog owner', async () => {
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'unknown'),
  ).rejects.toThrow(/authentication/i);
  cleanups.push(bindAgentLibraryTransport('expired', { id: 'login', expiresAt: Date.now() - 1 }));
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'expired'),
  ).rejects.toThrow(/authentication/i);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('uses the middleware verified login for the exact retained-owner read', async () => {
  const auth = { id: 'verified-login', expiresAt: Date.now() + 10000 };
  cleanups.push(bindAgentLibraryTransport('connection', auth));
  mocks.request.mockResolvedValue({ status: 404, body: {} });
  expect(await readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'connection')).toBeNull();
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'library.read',
      resourceId: 'bob',
      revision: '3',
      authorization: auth,
      body: {},
    }),
    undefined,
    expect.any(AbortSignal),
  );
});
it('invalidates an in-flight read on logout instead of returning its profile', async () => {
  cleanups.push(
    bindAgentLibraryTransport('connection', {
      id: 'verified-login',
      expiresAt: Date.now() + 10000,
    }),
  );
  mocks.request.mockImplementation(async () => {
    mocks.revoked();
    return { status: 404, body: {} };
  });
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'connection'),
  ).rejects.toThrow(/revoked/i);
  expect(mocks.invalidate).toHaveBeenCalledWith('verified-login');
});

it('rechecks the same verified operator after context compilation and refuses revoked or replaced bindings', () => {
  const auth = { id: 'verified-login', expiresAt: Date.now() + 10000 };
  cleanups.push(bindAgentLibraryTransport('connection', auth));
  const captured = captureAgentLibraryAuthorization('connection');
  expect(captured.auth).toBe(auth);
  captured.assertCurrent();
  mocks.revoked();
  expect(() => captured.assertCurrent()).toThrow(/revoked/);
  cleanups.push(bindAgentLibraryTransport('connection', { ...auth, id: 'another-login' }));
  expect(() => captured.assertCurrent()).toThrow(/revoked/);
});
