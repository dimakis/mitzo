import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins the conversation contracts, persistence, authenticated API and client projection in the runtime manifest', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../session-collaboration-router.ts',
    '../collaboration-context-compiler.ts',
    '../collaboration-context-source.ts',
    '../../packages/protocol/src/collaboration-visible-source.ts',
    '../../packages/protocol/src/session-collaboration-store.ts',
    '../../packages/protocol/src/collaboration-conversation.ts',
    '../../packages/protocol/src/collaboration-conversation-store.ts',
    '../../packages/protocol/src/event-store.ts',
    '../../packages/protocol/src/index.ts',
    '../../packages/client/src/api-client.ts',
    '../../packages/client/src/collaboration-api.ts',
    '../../packages/client/src/collaboration-projection.ts',
    '../../packages/client/src/index.ts',
  ]) {
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
