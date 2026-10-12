import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('binds transcript projections and reconnect snapshots to reviewed runtime sources', () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const module of ['conversation-replay-store', 'event-store']) {
    const relative = `../../packages/protocol/src/${module}.ts`;
    const source = readFileSync(
      new URL(relative, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[relative]).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
