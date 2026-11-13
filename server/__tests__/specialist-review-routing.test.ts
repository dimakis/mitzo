import { expect, it } from 'vitest';
import { specialistReviewDiversity, specialistReviewerRank } from '../specialist-review-routing.js';
import type { SpecialistRoute } from '../specialist-consultation-contract.js';

const planner = { provider: 'openai', model: 'proxy-model' } as SpecialistRoute;
it('does not infer model-family independence from a different provider protocol', () => {
  const reviewer = { provider: 'anthropic-api', model: 'proxy-model' } as SpecialistRoute;
  expect(specialistReviewDiversity(reviewer, planner)).toMatchObject({
    differentFamily: null,
    differentProviderFamily: true,
  });
  expect(specialistReviewDiversity(reviewer, planner).reason).toContain('unknown');
});
it('prefers explicit approved family diversity over protocol diversity', () => {
  const source = { ...planner, modelFamily: 'family-a' };
  const same = { provider: 'anthropic-api', modelFamily: 'family-a' } as SpecialistRoute;
  const different = { provider: 'openai', modelFamily: 'family-b' } as SpecialistRoute;
  expect(specialistReviewDiversity(same, source).differentFamily).toBe(false);
  expect(specialistReviewDiversity(different, source).differentFamily).toBe(true);
  expect(specialistReviewerRank(different, source)).toBeLessThan(
    specialistReviewerRank(same, source),
  );
});
