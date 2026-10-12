import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const refuse = () =>
  Error('Original byte-compatible native app source unavailable; retain owner and uncertainty');
const commit = /^[a-f0-9]{40}$/;
const sha = /^[a-f0-9]{64}$/;
const keys = [
  'sourceCommit',
  'sourceRoot',
  'runtimeArtifactsSha256',
  'dependenciesSha256',
  'workspaceDependenciesSha256',
  'controllerSourceSha256',
  'packageInputsSha256',
  'frontendArtifactsSha256',
];
function normalized(input) {
  if (
    !input ||
    Object.keys(input).sort().join() !== [...keys].sort().join() ||
    !commit.test(input.sourceCommit) ||
    typeof input.sourceRoot !== 'string' ||
    !input.sourceRoot.endsWith('/releases/' + input.sourceCommit.slice(0, 12)) ||
    keys.filter((key) => key.endsWith('Sha256')).some((key) => !sha.test(input[key]))
  )
    throw refuse();
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, input[key]])));
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Pure compatibility data, never original-owner/source acceptance authority. */
export function assertByteCompatibleNativeApp(original, candidate) {
  const a = normalized(original),
    b = normalized(candidate);
  for (const key of keys.filter(
    (key) => key.endsWith('Sha256') && key !== 'frontendArtifactsSha256',
  ))
    if (a[key] !== b[key]) throw refuse();
  if (a.sourceRoot.slice(0, -12) !== b.sourceRoot.slice(0, -12)) throw refuse();
}
/** Original trusted launcher wiring only. The accepted-source verifier and
 * complete physical file inspector are code capabilities, never JSON flags.
 * This bridge neither updates a child nor grants native capacity/model authority.
 * The real replacement executor must positively drain/replace its owned child
 * before invoking observeChild from the awaited original readiness hook. */
export function createOriginalNativeAppSourceBridge({
  nativeSource,
  assertOriginalCustodianCurrent,
  inspectSource,
  assertAcceptedCandidate,
  captureSourceContinuity,
  now = () => performance.now(),
}) {
  const original = normalized(nativeSource);
  if (
    [assertOriginalCustodianCurrent, inspectSource, assertAcceptedCandidate, now].some(
      (fn) => typeof fn !== 'function',
    )
  )
    throw refuse();
  if (captureSourceContinuity !== undefined && typeof captureSourceContinuity !== 'function')
    throw refuse();
  const proposals = new WeakMap();
  let latest;
  const sync = (fn) => {
    const result = fn();
    if (result instanceof Promise) {
      void result.catch(() => {});
      throw refuse();
    }
    if (result === false) throw refuse();
    return result;
  };
  const assert = (fn) => {
    if (sync(fn) !== undefined) throw refuse();
  };
  const read = (selected) => {
    assert(assertOriginalCustodianCurrent);
    const frozen = normalized(sync(() => inspectSource(selected)));
    if (frozen.sourceCommit !== selected) throw refuse();
    const native = normalized(sync(() => inspectSource(original.sourceCommit)));
    if (digest(native) !== digest(original)) throw refuse();
    assertByteCompatibleNativeApp(original, frozen);
    assert(assertOriginalCustodianCurrent);
    return frozen;
  };
  const accepted = async (selected) => {
    const result = await assertAcceptedCandidate(selected);
    if (result !== undefined) throw refuse();
  };
  const proposal = (token) => {
    const selected = token && proposals.get(token);
    if (!selected || selected.used || now() >= selected.deadline) throw refuse();
    return selected;
  };
  return Object.freeze({
    async qualify(selected) {
      if (!commit.test(selected)) throw refuse();
      const deadline = now() + 12 * 60 * 1000;
      assert(assertOriginalCustodianCurrent);
      await accepted(selected);
      const snapshot = read(selected);
      await accepted(selected);
      if (digest(read(selected)) !== digest(snapshot) || now() >= deadline) throw refuse();
      const token = Object.freeze({});
      proposals.set(token, { snapshot, deadline, used: false });
      return token;
    },
    async assertCandidateCurrent(token) {
      const candidate = proposal(token);
      await accepted(candidate.snapshot.sourceCommit);
      if (
        digest(read(candidate.snapshot.sourceCommit)) !== digest(candidate.snapshot) ||
        now() >= candidate.deadline
      )
        throw refuse();
    },
    observeChild(token, identity, current) {
      const candidate = proposal(token);
      assert(assertOriginalCustodianCurrent);
      if (
        typeof current !== 'function' ||
        !identity ||
        !Number.isSafeInteger(identity.epoch) ||
        identity.epoch < 1 ||
        !Number.isSafeInteger(identity.custodianPid) ||
        identity.custodianPid < 2 ||
        !Number.isSafeInteger(identity.controllerPid) ||
        identity.controllerPid < 2 ||
        identity.controllerPid === identity.custodianPid ||
        typeof identity.instanceId !== 'string' ||
        !identity.instanceId ||
        (latest &&
          (identity.epoch <= latest.identity.epoch ||
            identity.instanceId !== latest.identity.instanceId ||
            identity.custodianPid !== latest.identity.custodianPid ||
            identity.controllerPid === latest.identity.controllerPid))
      )
        throw refuse();
      assert(current);
      if (digest(read(candidate.snapshot.sourceCommit)) !== digest(candidate.snapshot))
        throw refuse();
      assert(current);
      if (now() >= candidate.deadline) throw refuse();
      // Capture only at the actual awaited child handoff, after complete byte
      // admission. The physical inspector retains its own file descriptors;
      // public snapshots cannot construct this ongoing source capability.
      const continuity =
        captureSourceContinuity && sync(() => captureSourceContinuity(candidate.snapshot));
      if (
        captureSourceContinuity &&
        (!continuity ||
          typeof continuity.assertCurrent !== 'function' ||
          typeof continuity.closeAfterReplacement !== 'function')
      )
        throw refuse();
      if (continuity) assert(() => continuity.assertCurrent());
      assert(current);
      candidate.used = true;
      const previous = latest;
      latest = Object.freeze({
        snapshot: candidate.snapshot,
        identity: Object.freeze({ ...identity }),
        current,
        continuity,
      });
      // The actual main control cannot publish the new child until it has
      // positively observed its original previous child exit. Only descriptors
      // captured for that previous child are released; native files stay held.
      if (previous?.continuity) assert(() => previous.continuity.closeAfterReplacement());
    },
    capture() {
      if (!latest) throw refuse();
      assert(assertOriginalCustodianCurrent);
      assert(latest.current);
      if (latest.continuity) assert(() => latest.continuity.assertCurrent());
      else if (digest(read(latest.snapshot.sourceCommit)) !== digest(latest.snapshot))
        throw refuse();
      assert(latest.current);
      return Object.freeze({
        nativeSourceCommit: original.sourceCommit,
        acceptedAppCommit: latest.snapshot.sourceCommit,
        appRoot: latest.snapshot.sourceRoot,
        instanceId: latest.identity.instanceId,
        epoch: latest.identity.epoch,
        controllerPid: latest.identity.controllerPid,
        custodianPid: latest.identity.custodianPid,
        compatibilitySha256: digest({ native: original, app: latest.snapshot }),
      });
    },
  });
}
