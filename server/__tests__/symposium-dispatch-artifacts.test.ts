import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('keeps the extracted dispatch authority in the reviewed source closure', async () => {
  const sources: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    'symposium-dispatch-boundary',
    'symposium-seat-runtime',
    'symposium-shared-execution',
  ]) {
    const source = await readFile(new URL(`../${file}.ts`, import.meta.url), 'utf8');
    expect(sources[`../${file}.ts`]).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
