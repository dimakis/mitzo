import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('binds session metadata and runtime bindings to reviewed runtime sources', () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const module of ['session-metadata-store', 'event-store']) {
    const relative = `../../packages/protocol/src/${module}.ts`;
    const source = readFileSync(
      new URL(relative, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[relative]).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
