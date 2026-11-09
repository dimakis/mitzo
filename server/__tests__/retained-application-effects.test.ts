import { expect, it, vi } from 'vitest';
import { retainedApplicationEffectObserver } from '../retained-application-effects.js';
import type { RetainedNativeEffectEvidence } from '../retained-native-effect-evidence.js';
import type { EventStore } from '../event-store.js';
const reader = vi.hoisted(() => ({ observeRetainedEdit: vi.fn() }));
vi.mock('../telos-main-publication-runtime.js', () => ({
  getTelosMainPublicationRuntime: () => reader,
}));
vi.mock('../historical-telos-edit-manifest.js', () => ({
  reviewedHistoricalTelosSources: {},
  reviewedHistoricalTelosEdits: [
    '6935e5026093c21134cd8d9dfd33ee1f7d1a338b52c98dc9eb449fa4d43a996f',
  ],
}));
it('qualifies only the exact reviewed no-commit observation, preserving failed evidence', () => {
  const binding = {
    accountId: 'account',
    accountLabel: 'Fixture',
    provider: 'openai-codex' as const,
    model: 'model',
    profileRevision: 'revision',
  };
  const evidence = {
    target: { commandId: 'command', attempt: 1, threadId: 'thread', turnId: 'turn', generation: 0 },
    execution: { phase: 'accepted', policy: { policyRevision: 'policy' } },
    custody: {
      version: 1,
      authSessionId: 'login',
      bootstrapId: 'bootstrap',
      agentProfileSha256: 'profile',
    },
    diagnostic: {
      workspaceDigest: 'workspace',
      runtimeBindingRevision: 'runtime',
      nativeArtifactSha256: 'artifact',
      nativeVersion: 'native',
      releaseRevision: 'release',
    },
    callId: 'call',
    requestHash: 'request-hash',
    effectOutcome: 'unknown',
    contentItems: null,
  } as RetainedNativeEffectEvidence;
  const observed = {
    canonicalDatabaseIdentity: { realpath: '/fixture/telos.db', dev: '1', ino: '2', uid: '3' },
    itemExists: true,
    updateReceipt: null,
  };
  const call = {
    toolName: 'TelosManageItem',
    arguments: {
      operation: 'edit',
      itemId: 'item',
      requestId: 'request',
      expectedRevision: 'a'.repeat(64),
      summary: 'Updated brief',
      note: 'Requested change',
    },
  };
  const result = { content: 'Original refusal', isError: true };
  const before = structuredClone({ evidence, observed, result });
  const events = {} as EventStore;
  const current = vi.fn();
  const observer = retainedApplicationEffectObserver(events, 'chat', binding, current);
  reader.observeRetainedEdit.mockReturnValue(observed);
  expect(observer(call, result, () => evidence)).toBe(true);
  expect(reader.observeRetainedEdit).toHaveBeenCalledWith(
    events,
    'item',
    'chat',
    'request',
    current,
  );
  for (const changed of [
    { ...observed, itemExists: false },
    { ...observed, updateReceipt: { receipt: 'committed' } },
    {
      ...observed,
      canonicalDatabaseIdentity: { ...observed.canonicalDatabaseIdentity, ino: 'replacement' },
    },
  ]) {
    reader.observeRetainedEdit.mockReturnValue(changed);
    expect(observer(call, result, () => evidence)).toBe(false);
  }
  reader.observeRetainedEdit.mockReturnValue(observed);
  for (const changed of [
    { ...evidence, requestHash: 'different-operation' },
    { ...evidence, target: { ...evidence.target, turnId: 'later-turn' } },
    { ...evidence, custody: { ...evidence.custody, bootstrapId: 'another-owner' } },
  ])
    expect(observer(call, result, () => changed)).toBe(false);
  expect(observer(call, { ...result, content: 'changed' }, () => evidence)).toBe(false);
  expect(observer(call, { ...result, isError: false }, () => evidence)).toBe(false);
  expect(
    retainedApplicationEffectObserver(
      events,
      'other-chat',
      binding,
      current,
    )(call, result, () => evidence),
  ).toBe(false);
  expect(
    retainedApplicationEffectObserver(
      events,
      'chat',
      { ...binding, accountId: 'other-account' },
      current,
    )(call, result, () => evidence),
  ).toBe(false);
  current.mockImplementation(() => {
    throw Error('revoked');
  });
  expect(() => observer(call, result, () => evidence)).toThrow('revoked');
  expect({ evidence, observed, result }).toEqual(before);
});
