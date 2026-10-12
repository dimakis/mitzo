import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const NATIVE_INFERENCE_CURRENT_PATH = '/api/staging/features/native-inference/current';
const purpose = 'mitzo-staging-native-inference-current-v1';
const hex64 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
function refuse(): never {
  throw Error('Original native inference current authentication unavailable');
}

export interface NativeInferenceOriginalBinding {
  gatewayInstance: string;
  acceptedAppCommit: string;
  nativeSourceCommit: string;
  ownerInstance: string;
}
export interface NativeInferenceCurrentRequest extends NativeInferenceOriginalBinding {
  version: 1;
  guardId: string;
  runId: string;
  planSha256: string;
  sessionId: string;
  claimToken: string;
  sandboxName: string;
  sandboxId: string;
  supervisorSession: string;
  wireSha256: string;
  phase:
    | 'prepare'
    | 'authorize'
    | 'before-headers'
    | 'before-body'
    | 'during-stream'
    | 'complete'
    | 'revoke';
  nonce: string;
  sequence: number;
}
export interface NativeInferenceCurrentEnvelope {
  canonicalBody: string;
  mac: string;
}
export interface NativeInferenceCurrentResponse {
  version: 1;
  kind: 'current';
  requestSha256: string;
  gatewayInstance: string;
  acceptedAppCommit: string;
  nativeSourceCommit: string;
  ownerInstance: string;
  nonce: string;
  sequence: number;
  phase: NativeInferenceCurrentRequest['phase'];
  wireSha256: string;
}
const requestKeys = [
  'version',
  'gatewayInstance',
  'acceptedAppCommit',
  'nativeSourceCommit',
  'ownerInstance',
  'guardId',
  'runId',
  'planSha256',
  'sessionId',
  'claimToken',
  'sandboxName',
  'sandboxId',
  'supervisorSession',
  'wireSha256',
  'phase',
  'nonce',
  'sequence',
] as const;
const responseKeys = [
  'version',
  'kind',
  'requestSha256',
  'gatewayInstance',
  'acceptedAppCommit',
  'nativeSourceCommit',
  'ownerInstance',
  'nonce',
  'sequence',
  'phase',
  'wireSha256',
] as const;
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    refuse();
}
function text(value: unknown, empty = false): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    (empty || value.length > 0) &&
    [...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
  );
}
function canonical(value: Record<string, unknown>, keys: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, value[key]])));
}
function requestBytes(value: unknown): string {
  exact(value, requestKeys);
  if (
    value.version !== 1 ||
    !commit.test(String(value.acceptedAppCommit)) ||
    !commit.test(String(value.nativeSourceCommit)) ||
    !hex64.test(String(value.planSha256)) ||
    !hex64.test(String(value.wireSha256)) ||
    !hex64.test(String(value.nonce)) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    Number(value.sequence) > 4096 ||
    ![
      'prepare',
      'authorize',
      'before-headers',
      'before-body',
      'during-stream',
      'complete',
      'revoke',
    ].includes(String(value.phase))
  )
    refuse();
  for (const key of [
    'gatewayInstance',
    'ownerInstance',
    'guardId',
    'runId',
    'sessionId',
    'claimToken',
    'sandboxName',
  ])
    if (!text(value[key])) refuse();
  for (const key of ['sandboxId', 'supervisorSession'])
    if (!text(value[key], value.phase === 'prepare')) refuse();
  return canonical(value, requestKeys);
}
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Purpose MAC transport only. This authenticates original private-key bytes and
 * live source binding; it does NOT supply account, model, queue, or dispatch
 * authority. Only the actual qualified gateway constructor may retain this
 * codec, and its run consumer must assert the original queue before responding.
 * No qualified-model protocol or public gateway registration is exported here. */
export function createNativeInferenceCurrentMacCodec({
  key,
  assertOriginalBinding,
}: {
  key: Buffer;
  assertOriginalBinding: () => NativeInferenceOriginalBinding;
}) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof assertOriginalBinding !== 'function')
    refuse();
  const secret = Buffer.from(key);
  const receivedSequence = new Map<string, number>();
  const pendingResponses = new WeakMap<object, string>();
  const sent = new Set<string>();
  const sentSequence = new Map<string, number>();
  const mac = (mode: string, body: string) =>
    createHmac('sha256', secret).update(`${purpose}\n${mode}\n${body}`, 'utf8').digest('hex');
  function assertBinding(request: NativeInferenceOriginalBinding) {
    const actual = assertOriginalBinding();
    for (const field of [
      'gatewayInstance',
      'acceptedAppCommit',
      'nativeSourceCommit',
      'ownerInstance',
    ] as const)
      if (actual[field] !== request[field]) refuse();
  }
  function verifyEnvelope(envelope: unknown, mode: string): string {
    exact(envelope, ['canonicalBody', 'mac']);
    if (
      typeof envelope.canonicalBody !== 'string' ||
      Buffer.byteLength(envelope.canonicalBody, 'utf8') > 8192 ||
      typeof envelope.mac !== 'string' ||
      !hex64.test(envelope.mac)
    )
      refuse();
    const expected = mac(mode, envelope.canonicalBody);
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(envelope.mac, 'hex'))) refuse();
    return envelope.canonicalBody;
  }
  return Object.freeze({
    requestNonce(guardId: string, sequence: number): string {
      if (!text(guardId) || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 4096)
        refuse();
      assertOriginalBinding();
      return mac('nonce', `${guardId}\n${sequence}`);
    },
    signRequest(request: NativeInferenceCurrentRequest): NativeInferenceCurrentEnvelope {
      const body = requestBytes(request);
      assertBinding(request);
      if (
        request.nonce !== mac('nonce', `${request.guardId}\n${request.sequence}`) ||
        sent.size >= 64 ||
        (!sentSequence.has(request.guardId) && sentSequence.size >= 4096) ||
        request.sequence <= (sentSequence.get(request.guardId) ?? 0)
      )
        refuse();
      const digest = sha(body);
      if (sent.has(digest)) refuse();
      sent.add(digest);
      sentSequence.set(request.guardId, request.sequence);
      return Object.freeze({
        canonicalBody: body,
        mac: mac(`POST\n${NATIVE_INFERENCE_CURRENT_PATH}`, body),
      });
    },
    verifyRequest(
      meta: { method: string; url: string },
      envelope: unknown,
    ): Readonly<NativeInferenceCurrentRequest> {
      if (meta.method !== 'POST' || meta.url !== NATIVE_INFERENCE_CURRENT_PATH) refuse();
      const body = verifyEnvelope(envelope, `POST\n${NATIVE_INFERENCE_CURRENT_PATH}`);
      const parsed: unknown = JSON.parse(body),
        bytes = requestBytes(parsed);
      if (bytes !== body) refuse();
      const request = parsed as unknown as NativeInferenceCurrentRequest;
      assertBinding(request);
      if (
        request.nonce !== mac('nonce', `${request.guardId}\n${request.sequence}`) ||
        (!receivedSequence.has(request.guardId) && receivedSequence.size >= 4096) ||
        request.sequence <= (receivedSequence.get(request.guardId) ?? 0)
      )
        refuse();
      receivedSequence.set(request.guardId, request.sequence);
      const verified = Object.freeze({ ...request });
      pendingResponses.set(verified, body);
      return verified;
    },
    signResponse(
      verified: Readonly<NativeInferenceCurrentRequest>,
      result: { kind: 'current' },
    ): NativeInferenceCurrentEnvelope {
      const body = pendingResponses.get(verified);
      if (!body) refuse();
      pendingResponses.delete(verified);
      exact(result, ['kind']);
      if (result.kind !== 'current') refuse();
      assertBinding(verified);
      const response: NativeInferenceCurrentResponse = {
        version: 1,
        kind: 'current',
        requestSha256: sha(body),
        gatewayInstance: verified.gatewayInstance,
        acceptedAppCommit: verified.acceptedAppCommit,
        nativeSourceCommit: verified.nativeSourceCommit,
        ownerInstance: verified.ownerInstance,
        nonce: verified.nonce,
        sequence: verified.sequence,
        phase: verified.phase,
        wireSha256: verified.wireSha256,
      };
      const bytes = canonical({ ...response }, responseKeys);
      return Object.freeze({ canonicalBody: bytes, mac: mac('response', bytes) });
    },
    verifyResponse(
      request: NativeInferenceCurrentRequest,
      envelope: unknown,
    ): Readonly<NativeInferenceCurrentResponse> {
      const body = requestBytes(request);
      assertBinding(request);
      const digest = sha(body);
      if (!sent.has(digest)) refuse();
      const bytes = verifyEnvelope(envelope, 'response');
      const parsed: unknown = JSON.parse(bytes);
      exact(parsed, responseKeys);
      const response = parsed as unknown as NativeInferenceCurrentResponse;
      if (
        canonical(parsed, responseKeys) !== bytes ||
        response.version !== 1 ||
        response.kind !== 'current' ||
        response.requestSha256 !== digest
      )
        refuse();
      for (const field of [
        'gatewayInstance',
        'acceptedAppCommit',
        'nativeSourceCommit',
        'ownerInstance',
        'nonce',
        'sequence',
        'phase',
        'wireSha256',
      ] as const)
        if (response[field] !== request[field]) refuse();
      sent.delete(digest);
      return Object.freeze({ ...response });
    },
  });
}
