import { expect, it } from 'vitest';
import { RuntimeReadinessSchema } from '../src/runtime-readiness.js';
import {
  runtimeReadinessFixture,
  readinessScopeMutations,
} from '../../../tests/support/runtime-readiness-fixture.js';

it.each(readinessScopeMutations)('rejects internally inconsistent %s evidence', (_name, mutate) => {
  const value = runtimeReadinessFixture();
  mutate(value);
  expect(RuntimeReadinessSchema.safeParse(value).success).toBe(false);
});
it('requires observed session and configured execution for measured capabilities', () => {
  const value = runtimeReadinessFixture();
  const unknown = { state: 'unknown' as const, reason: 'not_observed' as const };
  expect(RuntimeReadinessSchema.safeParse({ ...value, session: unknown }).success).toBe(false);
  expect(RuntimeReadinessSchema.safeParse({ ...value, execution: unknown }).success).toBe(false);
  expect(
    RuntimeReadinessSchema.safeParse({
      ...value,
      session: unknown,
      execution: unknown,
      capabilities: unknown,
    }).success,
  ).toBe(true);
});
it('retains matching observed, stale and legacy v1 evidence without manufacturing authority', () => {
  const value = runtimeReadinessFixture();
  expect(RuntimeReadinessSchema.safeParse(value).success).toBe(true);
  value.capabilities.state = 'stale';
  expect(RuntimeReadinessSchema.safeParse(value).success).toBe(true);
  const b = value.execution.binding;
  const legacy = {
    version: 1 as const,
    account: b.account,
    harness: b.harness,
    execution: { location: b.execution.location },
  };
  value.execution.binding = structuredClone(legacy);
  value.capabilities.evidence.scope.binding = structuredClone(legacy);
  expect(RuntimeReadinessSchema.safeParse(value).success).toBe(true);
});
