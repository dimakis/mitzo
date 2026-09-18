import { describe, expect, it } from 'vitest';
import { MAX_V2_IMAGE_ENCODED_CHARS, V2SendMessage } from '@mitzo/protocol';
import {
  canonicalizeExecutionRequest,
  fingerprintExecutionRequest,
  interruptReceiptFingerprint,
  MAX_EXECUTION_IMAGE_BYTES,
  MAX_EXECUTION_IMAGES,
  MAX_EXECUTION_IMAGE_BYTES_TOTAL,
  sha256Base64url,
  stableSerializeJson,
  validatedExecutionImages,
  type ExecutionRequestInput,
} from '../execution-request.js';

const request: ExecutionRequestInput = {
  operation: 'send',
  sessionId: null,
  rawUserIntent: 'Tell me about the plan',
  effectiveProviderPrompt: 'Tell me about the plan\n\nSystem context',
  accountId: 'acct-1',
  model: 'model-1',
  reasoningEffort: 'high',
  mode: 'agent',
  cwd: '/repo',
  extraTools: ['Bash', 'Read'],
  allowedTools: ['Read', 'Bash'],
  isolation: true,
  images: [{ mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }],
  contextBlocks: ['secret context block'],
  telosTaskId: 'telos-1',
  agentName: 'planner',
  skill: {
    name: 'plan',
    renderedPrompt: 'expanded skill body',
    allowedTools: ['Read', 'Bash'],
  },
};

describe('execution request fingerprint', () => {
  it('keeps interrupt receipt identity to immutable wire intent, not mutable runtime state', () => {
    const wire = {
      sessionId: 'session',
      prompt: 'replace the active turn',
      expectedExecutionId: 'old-token',
      expectedGeneration: 7,
      images: [{ mediaType: 'image/png', data: 'aW1hZ2UtYnl0ZXM=' }],
      contextBlocks: ['attached-file'],
    };
    const fingerprint = interruptReceiptFingerprint(wire);
    // File contents are intentionally not an input: the durable user_message
    // snapshots expansion, while the receipt binds only selector identity.
    const afterAttachedFileChanged = interruptReceiptFingerprint({
      ...wire,
      contextBlocks: ['attached-file'],
    });
    expect(afterAttachedFileChanged).toBe(fingerprint);

    // Compatibility callers cannot accidentally smuggle mutable session state
    // into the narrow receipt function; it has no model/mode/cwd inputs beyond
    // explicit wire selection.
    const withIgnoredRuntimeFields = interruptReceiptFingerprint as unknown as (
      input: typeof wire & {
        mode?: string;
        cwd?: string;
        effectiveModel?: string;
        effectiveReasoning?: string;
      },
    ) => string;
    expect(
      withIgnoredRuntimeFields({
        ...wire,
        mode: 'auto',
        cwd: '/a/new/worktree',
        effectiveModel: 'later-model',
        effectiveReasoning: 'high',
      }),
    ).toBe(fingerprint);
    expect(interruptReceiptFingerprint({ ...wire, model: 'explicit-model' })).not.toBe(fingerprint);
    expect(
      interruptReceiptFingerprint({
        ...wire,
        images: [{ mediaType: 'image/png', data: 'Y2hhbmdlZC1pbWFnZQ==' }],
      }),
    ).not.toBe(fingerprint);
  });

  it('is stable across recursively reordered object keys', () => {
    expect(stableSerializeJson({ z: [{ b: 2, a: 1 }], a: { d: null, c: true } })).toBe(
      '{"a":{"c":true,"d":null},"z":[{"a":1,"b":2}]}',
    );
    expect(fingerprintExecutionRequest(request)).toBe(
      fingerprintExecutionRequest({ ...request, extraTools: ['Read', 'Bash'] }),
    );
  });

  it('changes when any execution-affecting field changes', () => {
    const baseline = fingerprintExecutionRequest(request);
    const changes: ExecutionRequestInput[] = [
      { ...request, operation: 'interrupt' },
      { ...request, sessionId: 'session-1' },
      { ...request, rawUserIntent: 'other intent' },
      { ...request, effectiveProviderPrompt: 'other effective prompt' },
      { ...request, accountId: 'acct-2' },
      { ...request, model: 'model-2' },
      { ...request, reasoningEffort: 'low' },
      { ...request, mode: 'ask' },
      { ...request, cwd: '/other' },
      { ...request, extraTools: ['Write'] },
      { ...request, allowedTools: ['Write'] },
      { ...request, isolation: false },
      { ...request, images: [{ mediaType: 'image/jpeg', data: 'aW1hZ2UtYnl0ZXM=' }] },
      { ...request, images: [{ mediaType: 'image/png', data: 'b3RoZXItaW1hZ2UtYnl0ZXM=' }] },
      { ...request, contextBlocks: ['other context'] },
      { ...request, telosTaskId: 'telos-2' },
      { ...request, agentName: 'other-agent' },
      { ...request, skill: { ...request.skill!, name: 'other-skill' } },
      { ...request, skill: { ...request.skill!, renderedPrompt: 'other rendered prompt' } },
      { ...request, skill: { ...request.skill!, allowedTools: ['Write'] } },
    ];
    expect(changes.map(fingerprintExecutionRequest).every((value) => value !== baseline)).toBe(
      true,
    );
  });

  it('normalizes omitted optional fields and set-like tool arrays, while preserving ordered arrays', () => {
    const omitted: ExecutionRequestInput = {
      operation: 'send',
      rawUserIntent: 'intent',
      effectiveProviderPrompt: 'provider prompt',
    };
    const explicit: ExecutionRequestInput = {
      ...omitted,
      sessionId: null,
      accountId: null,
      model: null,
      reasoningEffort: null,
      mode: null,
      cwd: null,
      extraTools: [],
      allowedTools: [],
      isolation: null,
      images: [],
      contextBlocks: [],
      telosTaskId: null,
      agentName: null,
      skill: null,
    };
    expect(fingerprintExecutionRequest(omitted)).toBe(fingerprintExecutionRequest(explicit));
    expect(fingerprintExecutionRequest({ ...request, extraTools: ['Read', 'Bash', 'Read'] })).toBe(
      fingerprintExecutionRequest({ ...request, extraTools: ['Bash', 'Read'] }),
    );
    expect(fingerprintExecutionRequest({ ...request, contextBlocks: ['a', 'b'] })).not.toBe(
      fingerprintExecutionRequest({ ...request, contextBlocks: ['b', 'a'] }),
    );
  });

  it('never places image, prompt, context, or rendered skill plaintext in canonical data', () => {
    const canonical = stableSerializeJson(canonicalizeExecutionRequest(request));
    for (const secret of [
      request.rawUserIntent,
      request.effectiveProviderPrompt,
      'aW1hZ2UtYnl0ZXM=',
      request.contextBlocks![0],
      request.skill!.renderedPrompt,
    ]) {
      expect(canonical).not.toContain(secret);
    }
    expect(canonical).toContain(sha256Base64url('secret context block'));
    expect(canonical).toContain(sha256Base64url(Buffer.from('image-bytes')));
  });

  it('is deterministic for Unicode and rejects non-JSON/non-finite values', () => {
    const unicode = { ...request, rawUserIntent: 'こんにちは 👋 café' };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(fingerprintExecutionRequest(unicode)).toBe(fingerprintExecutionRequest(unicode));
    expect(() => stableSerializeJson({ nope: Number.NaN })).toThrow('non-finite');
    expect(() => stableSerializeJson({ nope: undefined })).toThrow('non-JSON');
    expect(() => stableSerializeJson({ nope: new Date() })).toThrow('plain objects');
    expect(() => stableSerializeJson(circular)).toThrow('circular');
  });

  it('strictly validates canonical image bytes before hashing', () => {
    const image = (data: string | Uint8Array) => [{ mediaType: 'image/png', data }];
    expect(validatedExecutionImages(image('aGVsbG8='))[0].bytes).toEqual(Buffer.from('hello'));
    expect(validatedExecutionImages(image('aGVsbG8'))[0].bytes).toEqual(Buffer.from('hello'));
    for (const malformed of [
      'aGV sbG8=',
      'aGVsbG8===',
      'aGVsbG8$',
      'data:image/png;base64,aGVsbG8=',
    ]) {
      expect(() => validatedExecutionImages(image(malformed))).toThrow('Image data');
    }
    expect(fingerprintExecutionRequest({ ...request, images: image('aGVsbG8=') })).toBe(
      fingerprintExecutionRequest({ ...request, images: image('aGVsbG8') }),
    );
    expect(fingerprintExecutionRequest({ ...request, images: image('aGVsbG8=') })).not.toBe(
      fingerprintExecutionRequest({ ...request, images: image('d29ybGQ=') }),
    );
    expect(() =>
      validatedExecutionImages([{ mediaType: 'application/octet-stream', data: 'aGVsbG8=' }]),
    ).toThrow('media type');
  });

  it('rejects oversized encoded image data before decode and schema admission', () => {
    const tooLong = 'A'.repeat(MAX_V2_IMAGE_ENCODED_CHARS + 1);
    expect(() => validatedExecutionImages([{ mediaType: 'image/png', data: tooLong }])).toThrow(
      'encoded data exceeds',
    );
    expect(() =>
      V2SendMessage.parse({
        type: 'send',
        sessionId: null,
        prompt: 'image',
        clientMsgId: 'oversized-before-decode',
        images: [{ mediaType: 'image/png', data: tooLong }],
      }),
    ).toThrow();
  });

  it('enforces decoded image count, per-image, aggregate, and boundary limits', () => {
    const atPerImageLimit = Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES);
    expect(
      validatedExecutionImages([{ mediaType: 'image/png', data: atPerImageLimit }]),
    ).toHaveLength(1);
    expect(() =>
      validatedExecutionImages([
        { mediaType: 'image/png', data: Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES + 1) },
      ]),
    ).toThrow('Image exceeds');
    expect(() =>
      validatedExecutionImages(
        Array.from({ length: MAX_EXECUTION_IMAGES + 1 }, () => ({
          mediaType: 'image/png',
          data: Buffer.alloc(1),
        })),
      ),
    ).toThrow('Too many images');
    const aggregate = [
      { mediaType: 'image/png', data: Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES) },
      { mediaType: 'image/png', data: Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES) },
    ];
    expect(validatedExecutionImages(aggregate)).toHaveLength(2);
    expect(() =>
      validatedExecutionImages([
        ...aggregate,
        {
          mediaType: 'image/png',
          data: Buffer.alloc(MAX_EXECUTION_IMAGE_BYTES_TOTAL - 2 * MAX_EXECUTION_IMAGE_BYTES + 1),
        },
      ]),
    ).toThrow('Images exceed');
  });
});
