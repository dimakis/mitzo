import { expect, it } from 'vitest';
import { reviewedHandlerSourceArtifacts } from '../connections/reviewed-handler-artifacts.js';

it('covers setup contracts, verification, guidance and continuation in the reviewed source closure', () => {
  for (const file of [
    'credential-connection-schema',
    'credential-setup',
    'connection-guide',
    'credential-setup-continuation',
    'credential-setup-application',
  ]) {
    expect(Object.hasOwn(reviewedHandlerSourceArtifacts, `../${file}.ts`)).toBe(true);
  }
});
