import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assessStagingProfileFeatures } from '../lib/staging-profile-features.mjs';

const sha = (digit) => digit.repeat(64);
function fixture() {
  const plan = {
    version: 1,
    sourceCommit: 'a'.repeat(40),
    suiteRevision: sha('b'),
    runnerRevision: sha('c'),
    referenceProfiles: [
      {
        id: 'personal',
        provider: 'openai-codex',
        runtime: 'local-codex',
        capabilities: ['streaming', 'tools'],
      },
    ],
    reservation: { requestId: 'feature-run', epoch: 2, ownerInstance: 'stage-owner' },
    limits: { maxProviderDispatches: 8, timeoutMs: 300000, maxOutputBytes: 65536 },
    profiles: [
      {
        referenceId: 'personal',
        profileId: 'stage-personal',
        provider: 'openai-codex',
        runtime: 'local-codex',
        profileRevision: sha('d'),
        runtimeRevision: sha('e'),
        authorization: 'ready',
        chargedAccount: 'personal-chatgpt',
        supportedModels: ['gpt-6-luna'],
        selectedModel: 'gpt-6-luna',
        modelApproval: null,
        requiredFeatures: ['stream-text', 'permission-denial'],
        capabilities: ['streaming', 'tools'],
      },
    ],
  };
  const result = {
    version: 1,
    sourceCommit: plan.sourceCommit,
    suiteRevision: plan.suiteRevision,
    runnerRevision: plan.runnerRevision,
    reservation: { ...plan.reservation },
    runId: 'run-1',
    profileId: 'stage-personal',
    provider: 'openai-codex',
    runtime: 'local-codex',
    profileRevision: sha('d'),
    runtimeRevision: sha('e'),
    chargedAccount: 'personal-chatgpt',
    selectedModel: 'gpt-6-luna',
    providerDispatches: 2,
    durationMs: 10000,
    outputBytes: 512,
    observations: [
      { feature: 'stream-text', outcome: 'passed', evidenceSha256: sha('1') },
      { feature: 'permission-denial', outcome: 'passed', evidenceSha256: sha('2') },
    ],
    cleanup: { state: 'confirmed', receiptSha256: sha('3') },
  };
  return { plan, result };
}
test('matching declarations remain unproven without original-owner evidence verification', () => {
  const { plan, result } = fixture();
  const report = assessStagingProfileFeatures(plan, [result]);
  assert.equal(report.runEvidenceMatches, true);
  assert.equal(report.liveFeatureValidation, 'not-live-proven');
  assert.deepEqual(report.issues, [
    { profileId: 'stage-personal', reason: 'owner-verification-required' },
  ]);
});
test('trusted owner verification must bind every complete result', () => {
  const { plan, result } = fixture();
  let verified;
  const report = assessStagingProfileFeatures(plan, [result], (value) => {
    verified = value;
    return true;
  });
  assert.deepEqual(verified, result);
  assert.equal(report.liveFeatureValidation, 'passed');
  assert.equal(
    assessStagingProfileFeatures(plan, [result], () => false).liveFeatureValidation,
    'not-live-proven',
  );
});
test('future profiles cannot disappear from the feature requirement set', () => {
  const { plan, result } = fixture();
  plan.profiles.push({
    ...plan.profiles[0],
    referenceId: 'future',
    profileId: 'stage-future',
    provider: 'future-provider',
    runtime: 'future-runtime',
  });
  assert.equal(
    assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
    'not-live-proven',
  );
});
test('complete reference coverage and exact capabilities are independently required', () => {
  const { plan, result } = fixture();
  plan.referenceProfiles.push({
    id: 'future',
    provider: 'future-provider',
    runtime: 'future-runtime',
    capabilities: ['future-feature'],
  });
  assert.equal(
    assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
    'not-live-proven',
  );
  plan.referenceProfiles.pop();
  plan.profiles[0].capabilities = ['tools'];
  assert.equal(
    assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
    'not-live-proven',
  );
});
test('ties results to source, suite, runner, reservation, profile, runtime, account and model', () => {
  for (const key of [
    'sourceCommit',
    'suiteRevision',
    'runnerRevision',
    'profileRevision',
    'runtimeRevision',
    'provider',
    'runtime',
    'chargedAccount',
    'selectedModel',
  ]) {
    const { plan, result } = fixture();
    result[key] =
      key === 'sourceCommit' ? 'f'.repeat(40) : key.endsWith('Revision') ? sha('f') : 'changed';
    assert.equal(
      assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
      'not-live-proven',
      key,
    );
  }
  const { plan, result } = fixture();
  result.reservation.epoch++;
  assert.equal(
    assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
    'not-live-proven',
  );
});
test('complete cleanup, positive model dispatch and each feature are mandatory', () => {
  for (const mutate of [
    (r) => {
      r.cleanup.state = 'uncertain';
    },
    (r) => {
      r.providerDispatches = 0;
    },
    (r) => {
      r.observations.pop();
    },
    (r) => {
      r.observations[0].outcome = 'failed';
    },
    (r) => {
      r.observations[0].outcome = 'skipped';
    },
  ]) {
    const { plan, result } = fixture();
    mutate(result);
    assert.equal(
      assessStagingProfileFeatures(plan, [result], () => true).liveFeatureValidation,
      'not-live-proven',
    );
  }
});
test('rejects unsupported models and unapproved alternate tests before proof assessment', () => {
  const { plan } = fixture();
  plan.profiles[0].selectedModel = 'gpt-6-sol';
  assert.throws(() => assessStagingProfileFeatures(plan, []), /model policy/);
  plan.profiles[0].supportedModels = ['claude-sonnet-4-6'];
  plan.profiles[0].selectedModel = 'claude-sonnet-4-6';
  assert.throws(() => assessStagingProfileFeatures(plan, []), /model policy/);
  plan.profiles[0].modelApproval = {
    decision: 'explicit-user-approval',
    approvalId: 'approval-vertex',
    account: 'personal-chatgpt',
    model: 'claude-sonnet-4-6',
    reason: 'luna-unavailable',
  };
  assert.equal(assessStagingProfileFeatures(plan, []).liveFeatureValidation, 'not-live-proven');
});
test('bounded resources apply to aggregate run results', () => {
  const { plan, result } = fixture();
  for (const [key, value] of [
    ['providerDispatches', 9],
    ['durationMs', 300001],
    ['outputBytes', 65537],
  ]) {
    const changed = structuredClone(result);
    changed[key] = value;
    assert.equal(
      assessStagingProfileFeatures(plan, [changed], () => true).liveFeatureValidation,
      'not-live-proven',
    );
  }
});
test('rejects credentials, duplicate identities, duplicate features and unexpected results', () => {
  const { plan, result } = fixture();
  assert.throws(() => assessStagingProfileFeatures({ ...plan, apiKey: 'secret' }, []), /public/);
  assert.throws(
    () => assessStagingProfileFeatures(plan, [{ ...result, credentialRef: '/secret' }]),
    /public/,
  );
  assert.throws(() => assessStagingProfileFeatures(plan, [result, result]), /unique/);
  plan.profiles.push(plan.profiles[0]);
  assert.throws(() => assessStagingProfileFeatures(plan, []), /unique/);
});
test('owner verification errors and non-boolean declarations fail closed', () => {
  const { plan, result } = fixture();
  for (const verifier of [
    () => {
      throw new Error('private raw detail');
    },
    () => Promise.resolve(true),
    () => ({ verified: true }),
  ]) {
    const report = assessStagingProfileFeatures(plan, [result], verifier);
    assert.equal(report.liveFeatureValidation, 'not-live-proven');
    assert.equal(JSON.stringify(report).includes('private raw detail'), false);
  }
});
