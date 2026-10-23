import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins product MCP image validation, hooks, receipt custody and native/UI serialization', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../codex-tool-result.ts',
    '../codex-mcp-tools.ts',
    '../native-hooks.ts',
    '../codex-conversation-store.ts',
    '../codex-conversation.ts',
    '../codex-session-events.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
