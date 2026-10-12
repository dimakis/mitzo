import { describe, expect, it, vi } from 'vitest';
import {
  createNativeInferenceCurrentMacCodec,
  type NativeInferenceCurrentRequest,
} from '../staging-native-inference-current-codec.js';
import { StagingNativeInferenceCurrentOwner } from '../staging-native-inference-current-owner.js';

const captured = vi.hoisted(() => ({ authentication: undefined as unknown }));
vi.mock('../staging-native-inference-current-auth.js', () => ({
  captureQualifiedNativeInferenceCurrentAuthentication: () => {
    if (!captured.authentication) throw Error('Unqualified native producer');
    return captured.authentication;
  },
}));

const meta = { method: 'POST', url: '/api/staging/features/native-inference/current' };
function fixture() {
  let resources = true,
    queue = true;
  const binding = {
    gatewayInstance: 'gateway',
    acceptedAppCommit: 'a'.repeat(40),
    nativeSourceCommit: 'b'.repeat(40),
    ownerInstance: 'owner',
  };
  const codec = createNativeInferenceCurrentMacCodec({
    key: Buffer.alloc(32, 3),
    assertOriginalBinding: () => binding,
  });
  captured.authentication = codec;
  const assertCurrent = vi.fn(() => {
    if (!queue || !resources) throw Error('original admission lost');
  });
  const assertCleanupCurrent = vi.fn(() => {
    if (!queue) throw Error('original private queue lost');
  });
  const run = {
    ...binding,
    runId: 'run',
    planSha256: 'c'.repeat(64),
    sessionId: 'session',
    claimToken: 'claim',
    sandboxName: 'sandbox',
    assertCurrent,
    assertCleanupCurrent,
  };
  const guard = { guardId: 'guard', assertCurrent: vi.fn() };
  const owner = new StagingNativeInferenceCurrentOwner({} as never);
  owner.registerGuard(run, guard);
  owner.bindSandbox(guard, 'actual-id');
  assertCurrent.mockClear();
  const request = (
    phase: NativeInferenceCurrentRequest['phase'] = 'before-headers',
    sequence = 1,
  ): NativeInferenceCurrentRequest => ({
    version: 1,
    ...binding,
    runId: run.runId,
    planSha256: run.planSha256,
    sessionId: run.sessionId,
    claimToken: run.claimToken,
    sandboxName: run.sandboxName,
    sandboxId: phase === 'prepare' ? '' : 'actual-id',
    supervisorSession: phase === 'prepare' ? '' : 'supervisor',
    guardId: guard.guardId,
    wireSha256: 'd'.repeat(64),
    phase,
    sequence,
    nonce: codec.requestNonce(guard.guardId, sequence),
  });
  return {
    owner,
    codec,
    request,
    assertCurrent,
    assertCleanupCurrent,
    pressure: () => {
      resources = false;
    },
    revokeQueue: () => {
      queue = false;
    },
  };
}

describe('actual source run matching after purpose authentication (offline fixtures only)', () => {
  it('requires qualified producer capture and rechecks the original private queue before a signed response', () => {
    const f = fixture(),
      body = f.request(),
      envelope = f.codec.signRequest(body);
    captured.authentication = undefined;
    expect(() => f.owner.current(meta, envelope)).toThrow(/Unqualified/);
    captured.authentication = f.codec;
    const response = f.owner.current(meta, envelope);
    expect(f.assertCurrent).toHaveBeenCalledOnce();
    expect(f.codec.verifyResponse(body, response).kind).toBe('current');
  });
  it.each(['runId', 'claimToken', 'sandboxId'] as const)(
    'rejects authenticated %s drift before asserting or signing',
    (field) => {
      const f = fixture();
      expect(() =>
        f.owner.current(meta, f.codec.signRequest({ ...f.request(), [field]: 'foreign' })),
      ).toThrow(/unavailable|differs/);
      expect(f.assertCurrent).not.toHaveBeenCalled();
      expect(f.assertCleanupCurrent).not.toHaveBeenCalled();
    },
  );
  it('allows known cleanup under pressure while refusing new writes and any revoked original queue', () => {
    const f = fixture();
    f.pressure();
    expect(() => f.owner.current(meta, f.codec.signRequest(f.request()))).toThrow(/admission lost/);
    const cleanup = f.request('revoke', 2);
    expect(
      f.codec.verifyResponse(cleanup, f.owner.current(meta, f.codec.signRequest(cleanup))).kind,
    ).toBe('current');
    expect(f.assertCleanupCurrent).toHaveBeenCalledOnce();
    f.revokeQueue();
    expect(() => f.owner.current(meta, f.codec.signRequest(f.request('complete', 3)))).toThrow(
      /queue lost/,
    );
  });
});
