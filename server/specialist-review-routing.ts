import type { SpecialistRoute } from './specialist-consultation-contract.js';

const providerFamily = (provider: string) =>
  provider.startsWith('anthropic-')
    ? 'anthropic'
    : provider.startsWith('openai')
      ? 'openai'
      : provider;
/** Protocol/account classes are not model identity, particularly for proxies.
 * Family labels are explicit operator-approved policy metadata, never guesses
 * from model names or a capability claim about an arbitrary endpoint. */
export function specialistReviewDiversity(reviewer: SpecialistRoute, original: SpecialistRoute) {
  const differentFamily =
    reviewer.modelFamily && original.modelFamily
      ? reviewer.modelFamily !== original.modelFamily
      : null;
  return {
    differentFamily,
    differentProviderFamily:
      providerFamily(reviewer.provider) !== providerFamily(original.provider),
    reason:
      differentFamily === true
        ? 'Different model families are explicitly identified in the approved policy.'
        : differentFamily === false
          ? 'Independent profile selected; the approved model family is the same.'
          : 'Independent profile selected; model-family diversity is unknown without explicit policy labels. Different provider protocols do not prove it.',
  };
}
export function specialistReviewerRank(reviewer: SpecialistRoute, original: SpecialistRoute) {
  const diversity = specialistReviewDiversity(reviewer, original);
  return diversity.differentFamily === true
    ? 0
    : diversity.differentFamily === false
      ? 3
      : diversity.differentProviderFamily
        ? 1
        : 2;
}
