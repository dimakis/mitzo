import { expect, it } from 'vitest';
import { CodexStartupError } from '../codex-startup-error.js';
import { SessionRuntimeError } from '../session-runtime-error.js';
import { retainCodexPreparationFailure } from '../codex-preparation-failure.js';
import { codexRuntimeErrorTelemetry } from '../codex-runtime-diagnostics.js';

it('preserves the original startup cause and safe stage across consumer and OpenShell wrappers', () => {
  const cause = new CodexStartupError('runtime_connection', Error('secret-token /private/path'));
  const consumer = retainCodexPreparationFailure('runtime_connection', cause);
  const owner = retainCodexPreparationFailure('runtime_admission', consumer);
  expect(owner).toBe(consumer);
  expect(owner).toBe(cause);
  const diagnostic = codexRuntimeErrorTelemetry(owner);
  expect(diagnostic).toMatchObject({
    startupPhase: 'runtime_connection',
  });
  expect(JSON.stringify(diagnostic)).not.toMatch(/secret-token|private\/path/);
  const receipt = new SessionRuntimeError('runtime_unavailable', { cause: owner });
  expect(receipt.publicMessage()).not.toMatch(/secret-token|private\/path/);
});

it('retains reviewed recovery reasons and reference IDs without exposing cause text', () => {
  const original = new SessionRuntimeError('unsettled_effects', { cause: Error('private') });
  const failure = retainCodexPreparationFailure('runtime_admission', original);
  expect(failure).toBe(original);
  expect(codexRuntimeErrorTelemetry(failure)).toEqual(original.telemetry());
});

it('does not trust arbitrary stage fields and bounds cyclic causes', () => {
  const forged = Object.assign(Error('private'), { preparationStage: 'secret' });
  forged.cause = forged;
  expect(codexRuntimeErrorTelemetry(forged)).toEqual({});
});

it('wraps an unclassified cause once, retaining only reviewed diagnostic fields', () => {
  const original = Object.assign(Error('secret private path'), { code: 'EACCES' });
  const failure = retainCodexPreparationFailure('runtime_admission', original);
  expect(failure.cause).toBe(original);
  expect(retainCodexPreparationFailure('runtime_connection', failure)).toBe(failure);
  expect(codexRuntimeErrorTelemetry(failure)).toMatchObject({
    startupPhase: 'runtime_admission',
    startupErrorCode: 'EACCES',
  });
});
