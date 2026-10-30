import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('binds transcript projections and reconnect snapshots to reviewed runtime sources', () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const relative of [
    '../../packages/protocol/src/conversation-replay-store.ts',
    '../../packages/protocol/src/event-store.ts',
    '../conversation-transcript.ts',
    '../message-stream-state.ts',
    '../codex-text-projection.ts',
  ]) {
    const source = readFileSync(
      new URL(relative, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[relative]).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
