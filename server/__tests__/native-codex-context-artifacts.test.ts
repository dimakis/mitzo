import { expect, it } from 'vitest';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';

it('pins native pack admission and the direct approved-search route in the reviewed runtime', () => {
  for (const file of [
    'native-codex-context-admission',
    'codex-approved-search',
    'symposium-seat-runtime',
    'symposium-subscription-native',
  ])
    expect(Object.hasOwn(reviewedHandlerSourceArtifacts, `../${file}.ts`)).toBe(true);
});
