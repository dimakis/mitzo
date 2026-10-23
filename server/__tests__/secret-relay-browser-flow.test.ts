import { afterEach, expect, it, vi } from 'vitest';
import { CredentialConnectionStore } from '../credential-connections.js';
import { SecretRelays } from '../secret-relay.js';
import { PrivateRelayBrowsers } from '../secret-relay-browser.js';
const stores: CredentialConnectionStore[] = [];
const browsers: PrivateRelayBrowsers[] = [];
afterEach(async () => {
  for (const b of browsers.splice(0)) await b.dispose();
  for (const s of stores.splice(0)) s.close();
});
function fixture() {
  const store = new CredentialConnectionStore(':memory:');
  stores.push(store);
  const driver = {
    login: vi.fn(async () => ({ challenge: true })),
    code: vi.fn(async () => {}),
    action: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const browser = new PrivateRelayBrowsers(async () => driver);
  browsers.push(browser);
  const vault = {
    save: vi.fn(async () => ({
      gateway: 'fixture',
      workspace: 'fixture',
      name: 'private-ref',
      providerId: '1',
      version: '1',
      profileVersion: '1',
    })),
    read: vi.fn(async () => 'private-password'),
  };
  const service = new SecretRelays(
    store,
    vault,
    () => {
      throw new Error();
    },
    vi.fn(),
    false,
    { browser },
  );
  const draft = service.prepare('chat', {
    label: 'Browser',
    targets: [
      {
        adapter: 'browser',
        origin: 'https://service.example',
        requests: [
          { path: '/login', methods: ['GET', 'POST'] },
          { path: '/whoami', methods: ['GET'] },
          { path: '/settings', methods: ['GET', 'POST'] },
        ],
        login: { path: '/login', passwordSelector: '#password', submitSelector: '#login' },
        mfa: { codeSelector: '#code', submitSelector: '#verify' },
        verification: { path: '/whoami', pointer: '/authenticated', equals: true },
        actions: [{ label: 'Save', path: '/settings', fields: [], submitSelector: '#save' }],
      },
    ],
  });
  return { store, driver, browser, vault, service, draft };
}
const signal = () => AbortSignal.timeout(1000);
it('stages a private OTP, resumes only through the agent permission gate and executes exact session actions once', async () => {
  const f = fixture();
  await f.service.complete(f.draft.id, 1, 'private-password', signal(), () => true);
  expect(await f.service.apply('chat', f.draft.id, 0, signal(), () => true)).toEqual({
    outcome: 'challenge_required',
    challenge: 'awaiting_code',
  });
  const pending = f.service.browserStatus(f.draft.id);
  const ready = f.service.provideBrowserCode(f.draft.id, pending.revision, 0, '123456', () => true);
  expect(ready.outcomes[0]).toEqual({ outcome: 'challenge_required', challenge: 'code_ready' });
  expect(ready.delivery).toBe('pending');
  expect(ready.continuation).toBe(1);
  expect(JSON.stringify(f.store.listRelays())).not.toMatch(/123456|private-password/);
  expect(f.driver.code).not.toHaveBeenCalled();
  await expect(f.service.apply('chat', f.draft.id, 0, signal(), () => false)).rejects.toThrow();
  expect(f.driver.code).not.toHaveBeenCalled();
  expect(await f.service.apply('chat', f.draft.id, 0, signal(), () => true)).toEqual({
    outcome: 'confirmed',
  });
  expect(f.driver.code).toHaveBeenCalledWith('123456', expect.anything());
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true);
  expect(f.driver.code).toHaveBeenCalledOnce();
  expect(await f.service.apply('chat', f.draft.id, 0, signal(), () => true, undefined, 0)).toEqual({
    outcome: 'confirmed',
  });
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true, undefined, 0);
  expect(f.driver.action).toHaveBeenCalledOnce();
  expect(f.vault.read).toHaveBeenCalledOnce();
});
it('retains uncertain MFA and action receipts without replay, even if the same tool is called again', async () => {
  const f = fixture();
  await f.service.complete(f.draft.id, 1, 'private-password', signal(), () => true);
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true);
  const pending = f.service.browserStatus(f.draft.id);
  f.service.provideBrowserCode(f.draft.id, pending.revision, 0, '123456', () => true);
  f.driver.code.mockRejectedValueOnce(new Error('123456 private-password'));
  expect(await f.service.apply('chat', f.draft.id, 0, signal(), () => true)).toEqual({
    outcome: 'unconfirmed',
  });
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true);
  expect(f.driver.code).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.service.browserStatus(f.draft.id))).not.toMatch(
    /123456|private-password/,
  );
});
it('revokes private contexts and denies stale or duplicate MFA capture', async () => {
  const f = fixture();
  await f.service.complete(f.draft.id, 1, 'private-password', signal(), () => true);
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true);
  const r = f.service.browserStatus(f.draft.id);
  expect(() =>
    f.service.provideBrowserCode(r.id, r.revision + 1, 0, '123456', () => true),
  ).toThrow();
  f.service.cancel(r.id, r.revision);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.driver.close).toHaveBeenCalledOnce();
  expect(() => f.service.provideBrowserCode(r.id, r.revision, 0, '123456', () => true)).toThrow();
});
it('does not replay an uncertain browser action or restore a lost session by signing in again', async () => {
  const f = fixture();
  f.driver.login.mockResolvedValueOnce({ challenge: false });
  await f.service.complete(f.draft.id, 1, 'private-password', signal(), () => true);
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true);
  f.driver.action.mockRejectedValueOnce(new Error('private-password'));
  expect(await f.service.apply('chat', f.draft.id, 0, signal(), () => true, undefined, 0)).toEqual({
    outcome: 'unconfirmed',
  });
  await f.service.apply('chat', f.draft.id, 0, signal(), () => true, undefined, 0);
  expect(f.driver.action).toHaveBeenCalledOnce();
  expect(f.driver.login).toHaveBeenCalledOnce();
  expect(f.service.browserStatus(f.draft.id).actionOutcomes).toEqual({
    '0:0': { outcome: 'unconfirmed' },
  });
});
