import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  body: '',
  ino: 7,
  registered: true,
  ownerChecks: 0,
  login: vi.fn(),
  verify: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock('node:fs', () => ({
  constants: { O_RDONLY: 0, O_NOFOLLOW: 256 },
  openSync: vi.fn(() => 72),
  closeSync: vi.fn(),
  realpathSync: (path: string) => path,
  readFileSync: () => Buffer.from(fixture.body),
  fstatSync: () => ({
    isFile: () => true,
    uid: process.getuid?.(),
    mode: 0o100600,
    dev: 1,
    ino: fixture.ino,
    nlink: 1,
    size: Buffer.byteLength(fixture.body),
  }),
  lstatSync: (path: string) =>
    path.endsWith('.json')
      ? { dev: 1, ino: fixture.ino, size: Buffer.byteLength(fixture.body) }
      : { isDirectory: () => true, uid: process.getuid?.(), mode: 0o40700 },
}));
vi.mock('node:os', () => ({ userInfo: () => ({ homedir: '/synthetic-home' }) }));
vi.mock('../operator-session.js', () => ({
  login: fixture.login,
  authenticateToken: fixture.authenticate,
}));
vi.mock('jose', () => ({ jwtVerify: fixture.verify }));
import {
  createOriginalStagingNativeBootstrap,
  captureOriginalStagingNativeBootstrap,
  captureOriginalStagingStageDelegation,
  type StagingNativeFeatureBootstrap,
} from '../staging-native-feature-bootstrap.js';
import { createOriginalStagingAppSourceWitness } from '../staging-native-app-witness.js';
const root = '/synthetic-home/.local/share/mitzo-staging';
const commit = 'a'.repeat(40);
const sourceRoot = root + '/releases/' + commit.slice(0, 12);
const operatorPath =
  root +
  '/symposium/allocations/11111111-1111-1111-1111-111111111111/service/staging-operator.json';
const operator = {
  AUTH_SECRET: 's'.repeat(64),
  AUTH_PASSPHRASE: 'p'.repeat(32),
  PORT: '3190',
  MITZO_BIND_HOST: '127.0.0.1',
};
function input(): StagingNativeFeatureBootstrap {
  return {
    sourceCommit: commit,
    sourceRoot,
    fixtureRoot: root + '/symposium/allocations/11111111-1111-1111-1111-111111111111/workspace',
    assertOriginalOwnerCurrent() {
      fixture.ownerChecks++;
    },
    observeResources() {
      throw Error('No VM in source fixture');
    },
  };
}
function construct(value = input()) {
  return createOriginalStagingNativeBootstrap(value, operatorPath, () => {
    if (!fixture.registered) throw Error('Original source guard lost');
  });
}
beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(sourceRoot);
  for (const [key, value] of Object.entries(operator)) vi.stubEnv(key, value);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  fixture.body = JSON.stringify(operator);
  fixture.ino = 7;
  fixture.registered = true;
  fixture.ownerChecks = 0;
  fixture.login.mockReset();
  fixture.verify.mockReset();
  fixture.authenticate.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('rejects JSON/bootstrap replay and keeps pre-gateway source custody independent of full host custody', () => {
  const raw = input();
  expect(() => captureOriginalStagingNativeBootstrap(raw)).toThrow(/original native bootstrap/i);
  const bootstrap = construct(raw),
    cap = captureOriginalStagingNativeBootstrap(bootstrap);
  const ownerChecks = fixture.ownerChecks;
  cap.assertCurrent();
  expect(fixture.ownerChecks).toBe(ownerChecks);
  expect(() => cap.captureAcceptedAppSource('owner')).toThrow(/unavailable/i);
  fixture.registered = false;
  expect(() => cap.assertCurrent()).toThrow(/guard lost/i);
  expect(fixture.login).not.toHaveBeenCalled();
});
it('captures the actual awaited app witness and refuses replaced private inputs and asynchronous guard declarations', () => {
  let childReady = false;
  const bootstrap = construct({
    ...input(),
    acceptedAppSource: createOriginalStagingAppSourceWitness(() => {
      if (!childReady) throw Error('Actual child not ready');
      return {
        nativeSourceCommit: commit,
        acceptedAppCommit: commit,
        appRoot: sourceRoot,
        instanceId: 'owner',
        custodianPid: process.pid,
        controllerPid: process.pid + 1,
        epoch: 1,
        compatibilitySha256: 'b'.repeat(64),
      };
    }),
  });
  const cap = captureOriginalStagingNativeBootstrap(bootstrap);
  expect(() => cap.captureAcceptedAppSource('owner')).toThrow(/not ready/i);
  childReady = true;
  expect(cap.captureAcceptedAppSource('owner').controllerPid).toBe(process.pid + 1);
  fixture.ino++;
  expect(() => cap.assertCurrent()).toThrow(/unavailable/i);
  expect(() => createOriginalStagingNativeBootstrap(input(), operatorPath, async () => {})).toThrow(
    /unavailable/i,
  );
});
it('binds delegation to the immutable stage key and refuses lost source or expired synthetic auth after awaits', async () => {
  const delegation = captureOriginalStagingStageDelegation(construct());
  const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 60000;
  fixture.login.mockResolvedValue('synthetic-token');
  fixture.verify.mockResolvedValue({
    payload: { sub: 'user', jti: 'synthetic-session', exp: expiresAt / 1000 },
  });
  fixture.authenticate.mockResolvedValue({ id: 'synthetic-session', expiresAt });
  await expect(delegation.mint()).resolves.toEqual({
    authorization: 'Bearer synthetic-token',
    expiresAt,
  });
  expect(fixture.verify).toHaveBeenCalledWith(
    'synthetic-token',
    new TextEncoder().encode(operator.AUTH_SECRET),
    { algorithms: ['HS256'] },
  );
  fixture.authenticate.mockImplementationOnce(async () => {
    fixture.registered = false;
    return { id: 'synthetic-session', expiresAt };
  });
  await expect(delegation.mint()).rejects.toThrow(/guard lost/i);
  fixture.registered = true;
  fixture.authenticate.mockResolvedValue({ id: 'synthetic-session', expiresAt: 0 });
  await expect(delegation.mint()).rejects.toThrow(/unavailable/i);
});
