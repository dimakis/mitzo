import { describe, expect, it } from 'vitest';
import {
  canonicalizeExecutionRequest,
  fingerprintExecutionRequest,
  sha256Base64url,
  stableSerializeJson,
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
});
