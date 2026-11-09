import { expect, it, vi } from 'vitest';
import { qualifiesReviewedHistoricalTaskFailure } from '../historical-task-failure-evidence.js';
vi.mock('../historical-task-failure-manifest.js', () => ({
  reviewedHistoricalTaskFailures: [
    'b6f766d5419f51a22d4a100a16fee585b2f01431f3c7c62c524139441f8abf6b',
  ],
}));
const evidence = {
  version: 'mitzo-historical-task-failure-v1',
  kind: 'foreground_invocation_terminated',
  conversationId: 'fixture-chat',
  accountKey: 'fixture-account',
  nativeTarget: {
    commandId: 'fixture-command',
    attempt: 1,
    threadId: 'fixture-thread',
    turnId: 'fixture-turn',
    generation: 0,
  },
  acceptedExecutionHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  originalWorkspaceDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  originalPolicyRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  originalRuntimeBindingRevision: 'fixture-runtime',
  originalNativeArtifactSha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  originalNativeVersion: '0.160.0',
  originalReleaseRevision: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  reviewedSourceHashesDigest: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  nativeCall: {
    callId: 'fixture-call',
    toolName: 'TaskExecution',
    requestHash: '0000000000000000000000000000000000000000000000000000000000000000',
    resultContentSha256: '1111111111111111111111111111111111111111111111111111111111111111',
    resultIsError: true,
    resultEffectOutcome: 'unknown',
    resultContentItems: null,
    terminalStatus: 'failed',
    terminalSuccess: false,
  },
  taskRun: {
    grantId: 'fixture-grant',
    grantIdentityHash: '2222222222222222222222222222222222222222222222222222222222222222',
    memberIdentityHash: '3333333333333333333333333333333333333333333333333333333333333333',
    sessionId: 'fixture-chat',
    requestId: 'fixture-request',
    operation: 'run',
    cwd: '/fixture',
    fingerprint: '4444444444444444444444444444444444444444444444444444444444444444',
    result: null,
  },
  originalCustodyIdentity: {
    version: 1,
    authSessionId: 'fixture-login',
    bootstrapId: 'fixture-bootstrap',
    agentProfileSha256: '5555555555555555555555555555555555555555555555555555555555555555',
  },
};
it('requires the entire exact reviewed historical failure and preserves unknown evidence', () => {
  const before = structuredClone(evidence);
  expect(qualifiesReviewedHistoricalTaskFailure(evidence)).toBe(true);
  expect(evidence).toEqual(before);
  const mutations = [
    { ...evidence, conversationId: 'another-chat' },
    { ...evidence, accountKey: 'changed-account' },
    { ...evidence, nativeTarget: { ...evidence.nativeTarget, attempt: 2 } },
    { ...evidence, nativeTarget: { ...evidence.nativeTarget, turnId: 'later-turn' } },
    { ...evidence, acceptedExecutionHash: 'changed-policy' },
    { ...evidence, nativeCall: { ...evidence.nativeCall, resultContentSha256: 'changed-result' } },
    { ...evidence, nativeCall: { ...evidence.nativeCall, resultContentItems: [] } },
    { ...evidence, taskRun: { ...evidence.taskRun, result: { content: 'late', isError: true } } },
    { ...evidence, taskRun: { ...evidence.taskRun, fingerprint: 'different-request' } },
    { ...evidence, taskRun: { ...evidence.taskRun, memberIdentityHash: 'other-member' } },
    {
      ...evidence,
      originalCustodyIdentity: { ...evidence.originalCustodyIdentity, bootstrapId: 'new-owner' },
    },
    { ...evidence, originalReleaseRevision: 'unknown-source' },
  ];
  for (const value of mutations) expect(qualifiesReviewedHistoricalTaskFailure(value)).toBe(false);
  expect(qualifiesReviewedHistoricalTaskFailure({ state: 'uncertain', isError: true })).toBe(false);
});
