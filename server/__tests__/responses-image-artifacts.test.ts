import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins image admission, durable history and provider serialization in the reviewed runtime', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../chat.ts',
    '../responses-input.ts',
    '../responses-chat-session.ts',
    '../native-responses-runner.ts',
    '../gemini-session.ts',
    '../codex-chat-session.ts',
    '../codex-conversation-store.ts',
    '../codex-conversation.ts',
    '../codex-ordinary-packet.ts',
    '../../packages/harness/src/providers/session-types.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
