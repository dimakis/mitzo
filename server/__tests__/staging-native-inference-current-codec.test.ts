import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createNativeInferenceCurrentMacCodec } from '../staging-native-inference-current-codec.js';

const binding = {
  gatewayInstance: 'original-gateway',
  nativeSourceCommit: 'a'.repeat(40),
  acceptedAppCommit: 'b'.repeat(40),
  ownerInstance: 'original-owner',
};
const request = () => ({
  version: 1 as const,
  ...binding,
  guardId: 'guard',
  runId: 'run',
  planSha256: 'c'.repeat(64),
  sessionId: 'session',
  claimToken: 'claim',
  sandboxName: 'owned-sandbox',
  sandboxId: 'actual-sandbox',
  supervisorSession: 'original-supervisor-session',
  wireSha256: 'd'.repeat(64),
  phase: 'before-headers' as const,
  nonce: createHmac('sha256', Buffer.alloc(32, 7))
    .update('mitzo-staging-native-inference-current-v1\nnonce\nguard\n1')
    .digest('hex'),
  sequence: 1,
});
const path = '/api/staging/features/native-inference/current';
function fixture() {
  let alive = true;
  const actual = { ...binding };
  const codec = createNativeInferenceCurrentMacCodec({
    key: Buffer.alloc(32, 7),
    assertOriginalBinding: () => {
      if (!alive) throw Error('lost source owner');
      return { ...actual };
    },
  });
  return {
    codec,
    lose: () => {
      alive = false;
    },
    handoff: () => {
      actual.acceptedAppCommit = 'f'.repeat(40);
    },
  };
}
describe('purpose-bound current MAC transport, separate from model authority', () => {
  it('authenticates exact canonical embedded bytes and signs only the same one-use verified object', () => {
    const { codec } = fixture(),
      envelope = codec.signRequest(request());
    const verified = codec.verifyRequest({ method: 'POST', url: path }, envelope);
    expect(verified.sandboxId).toBe('actual-sandbox');
    expect(() => codec.signResponse({ ...verified }, { kind: 'current' })).toThrow();
    const response = codec.signResponse(verified, { kind: 'current' });
    expect(codec.verifyResponse(request(), response).kind).toBe('current');
    expect(() => codec.verifyResponse(request(), response)).toThrow();
    expect(() => codec.signResponse(verified, { kind: 'current' })).toThrow();
  });
  it('rejects ordinary bearer-like JSON, wrong purpose/path, changed body and replay', () => {
    const { codec } = fixture(),
      envelope = codec.signRequest(request());
    expect(() => codec.verifyRequest({ method: 'GET', url: path }, envelope)).toThrow();
    expect(() =>
      codec.verifyRequest({ method: 'POST', url: path + '?grant=true' }, envelope),
    ).toThrow();
    expect(() =>
      codec.verifyRequest(
        { method: 'POST', url: path },
        { ...envelope, canonicalBody: envelope.canonicalBody + ' ' },
      ),
    ).toThrow();
    codec.verifyRequest({ method: 'POST', url: path }, envelope);
    expect(() => codec.verifyRequest({ method: 'POST', url: path }, envelope)).toThrow();
  });
  it('rejects duplicate/unknown tuple keys and an old app source after a legitimate source handoff', () => {
    const { codec, handoff } = fixture();
    const unknownKey = { ...request(), unknown: true };
    expect(() => codec.signRequest(unknownKey)).toThrow();
    const envelope = codec.signRequest(request());
    const duplicate = envelope.canonicalBody.replace('"version":1', '"version":1,"version":1');
    expect(() =>
      codec.verifyRequest({ method: 'POST', url: path }, { ...envelope, canonicalBody: duplicate }),
    ).toThrow();
    expect(() => codec.signRequest({ ...request(), acceptedAppCommit: 'f'.repeat(40) })).toThrow();
    handoff();
    expect(() => codec.verifyRequest({ method: 'POST', url: path }, envelope)).toThrow();
  });
  it('rechecks original source ownership before a response to an already verified request', () => {
    const f = fixture(),
      envelope = f.codec.signRequest(request());
    const verified = f.codec.verifyRequest({ method: 'POST', url: path }, envelope);
    f.lose();
    expect(() => f.codec.signResponse(verified, { kind: 'current' })).toThrow('lost source owner');
  });
  it('permits missing runtime IDs only during exact prepared-sandbox admission', () => {
    const { codec } = fixture();
    expect(() =>
      codec.signRequest({ ...request(), sandboxId: '', supervisorSession: '' }),
    ).toThrow();
    expect(
      codec.signRequest({ ...request(), phase: 'prepare', sandboxId: '', supervisorSession: '' }),
    ).toHaveProperty('mac');
  });
});
