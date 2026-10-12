import type { OriginalStagingAppSourceWitness } from './staging-native-app-witness.js';
import { captureOriginalStagingAppSource } from './staging-native-app-witness.js';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { jwtVerify } from 'jose';
import { login, authenticateToken } from './operator-session.js';
/** Paired source preflight only; actual instances additionally require the private brand. */
export const ORIGINAL_STAGING_NATIVE_BOOTSTRAP_PROTOCOL_VERSION = 1;
/** Fresh canonical launcher capabilities, passed in the same process. This is
 * not an enrollment record, IPC payload or native feature implementation.
 * Provider/configuration enrollment and original per-run native cleanup remain
 * independently required even after a new allocation has device authorization. */
export interface StagingNativeFeatureBootstrap {
  readonly sourceCommit: string;
  readonly sourceRoot: string;
  readonly fixtureRoot: string;
  /** Actual original launcher may supply a live accepted-child compatibility witness. */
  readonly acceptedAppSource?: OriginalStagingAppSourceWitness;
  assertOriginalOwnerCurrent(): void;
  /** Original retained VM owner observation. JSON cannot recreate this capability. */
  observeResources(): Readonly<{
    aggregateGiB: number;
    growthGiB: number;
    diskFreeGiB: number;
    vmMemoryMiB: 4096;
    vmCpus: 2;
    allocationUUID: string;
    planSha256: string;
    bootUUID: string;
    supervisorPid: number;
    vfkitPid: number;
    observationSha256: string;
    nativeRetirementClaim: false;
  }>;
}
type PrivateBootstrap = {
  input: StagingNativeFeatureBootstrap;
  operatorPath: string;
  operatorIdentity: string;
  operatorSha256: string;
  assertRegisteredSourceCurrent(): void;
  assertNewControlSourceCurrent?: () => void;
};
const originalBootstraps = new WeakMap<object, PrivateBootstrap>();
const refuse = () =>
  Error('Actual original native bootstrap or private stage delegation unavailable');
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');
function sync(assertion: () => void) {
  const result: unknown = assertion();
  if (result !== undefined) {
    if (result instanceof Promise) void result.catch(() => {});
    throw refuse();
  }
}
function operatorInput(path: string) {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      realpathSync(path) !== path
    )
      throw refuse();
    const body = readFileSync(fd),
      named = lstatSync(path);
    if (named.dev !== stat.dev || named.ino !== stat.ino || named.size !== stat.size)
      throw refuse();
    const value = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !== 'AUTH_PASSPHRASE,AUTH_SECRET,MITZO_BIND_HOST,PORT' ||
      typeof value.AUTH_SECRET !== 'string' ||
      value.AUTH_SECRET.length < 64 ||
      typeof value.AUTH_PASSPHRASE !== 'string' ||
      value.AUTH_PASSPHRASE.length < 32 ||
      value.PORT !== '3190' ||
      value.MITZO_BIND_HOST !== '127.0.0.1' ||
      value.AUTH_SECRET !== process.env.AUTH_SECRET ||
      value.AUTH_PASSPHRASE !== process.env.AUTH_PASSPHRASE ||
      process.env.PORT !== '3190' ||
      process.env.MITZO_BIND_HOST !== '127.0.0.1'
    )
      throw refuse();
    return {
      value,
      identity: [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink].join(':'),
      sha256: sha(body),
    };
  } finally {
    closeSync(fd);
  }
}
/** Actual allocation actor calls this after original VM running proof. It
 * captures its private operator inputs, never a bearer/configuration JSON grant.
 * The callback remains bound to the actor's real guard/registered/VM lifetime. */
export function createOriginalStagingNativeBootstrap(
  input: StagingNativeFeatureBootstrap,
  operatorPath: string,
  assertRegisteredSourceCurrent: () => void,
  assertNewControlSourceCurrent?: () => void,
): StagingNativeFeatureBootstrap {
  const root = join(userInfo().homedir, '.local/share/mitzo-staging');
  if (
    !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
    input.sourceRoot !== join(root, 'releases', input.sourceCommit.slice(0, 12)) ||
    process.cwd() !== input.sourceRoot ||
    process.send ||
    process.env.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER ||
    typeof input.assertOriginalOwnerCurrent !== 'function' ||
    typeof input.observeResources !== 'function' ||
    typeof assertRegisteredSourceCurrent !== 'function'
  )
    throw refuse();
  const relative = operatorPath.slice(join(root, 'symposium/allocations').length);
  if (
    operatorPath !== join(root, 'symposium/allocations') + relative ||
    input.fixtureRoot !== join(dirname(dirname(operatorPath)), 'workspace') ||
    !/^\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/service\/staging-operator\.json$/.test(
      relative,
    )
  )
    throw refuse();
  sync(assertRegisteredSourceCurrent);
  sync(input.assertOriginalOwnerCurrent);
  const operator = operatorInput(operatorPath);
  sync(input.assertOriginalOwnerCurrent);
  sync(assertRegisteredSourceCurrent);
  const frozen = Object.freeze({ ...input });
  originalBootstraps.set(frozen, {
    input: frozen,
    operatorPath,
    operatorIdentity: operator.identity,
    operatorSha256: operator.sha256,
    assertRegisteredSourceCurrent,
    ...(assertNewControlSourceCurrent ? { assertNewControlSourceCurrent } : {}),
  });
  return frozen;
}
function original(value: StagingNativeFeatureBootstrap) {
  const captured = originalBootstraps.get(value);
  if (!captured) throw refuse();
  // Gateway's own custody verification must never recursively enter the host
  // through its full owner/VM callback. This is independent source liveness;
  // feature admission/cleanup retains that separate full physical owner fence.
  sync(captured.assertRegisteredSourceCurrent);
  const operator = operatorInput(captured.operatorPath);
  if (
    operator.identity !== captured.operatorIdentity ||
    operator.sha256 !== captured.operatorSha256
  )
    throw refuse();
  sync(captured.assertRegisteredSourceCurrent);
  return { captured, operator };
}
/** Source/guard binding is available before gateway or app construction. App
 * identity is independently unavailable until the actual awaited child proof. */
export function captureOriginalStagingNativeBootstrap(value: StagingNativeFeatureBootstrap) {
  original(value);
  return Object.freeze({
    sourceCommit: value.sourceCommit,
    sourceRoot: value.sourceRoot,
    assertCurrent: () => {
      original(value);
    },
    /** Full prepared/dependency proof for a new native control. This expensive
     * admission is separate from the ongoing loaded-source current assertion. */
    assertNewControlSourceCurrent() {
      const { captured } = original(value);
      if (!captured.assertNewControlSourceCurrent) throw refuse();
      sync(captured.assertNewControlSourceCurrent);
      original(value);
    },
    captureAcceptedAppSource(ownerInstance: string) {
      original(value);
      if (!value.acceptedAppSource) throw refuse();
      const source = captureOriginalStagingAppSource(
        value.acceptedAppSource,
        value.sourceCommit,
        ownerInstance,
      );
      original(value);
      return source;
    },
  });
}
/** Normal stage authentication minted only by this original source capability.
 * JWT expiry does not reclaim native ownership. The gateway renews its own
 * exact private delegation file; the immutable purpose key is separate. */
export function captureOriginalStagingStageDelegation(value: StagingNativeFeatureBootstrap) {
  original(value);
  return Object.freeze({
    assertCurrent: () => {
      original(value);
    },
    async mint() {
      const { operator } = original(value);
      const token = await login(operator.value.AUTH_PASSPHRASE as string);
      original(value);
      if (!token) throw refuse();
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(operator.value.AUTH_SECRET as string),
        { algorithms: ['HS256'] },
      );
      const session = await authenticateToken(token);
      original(value);
      if (
        !session ||
        payload.sub !== 'user' ||
        payload.jti !== session.id ||
        !payload.exp ||
        payload.exp * 1000 !== session.expiresAt ||
        Date.now() >= session.expiresAt
      )
        throw refuse();
      return Object.freeze({ authorization: 'Bearer ' + token, expiresAt: session.expiresAt });
    },
  });
}
