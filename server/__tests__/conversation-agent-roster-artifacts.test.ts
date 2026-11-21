import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins the shared roster display, retention and existing panel owner', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../../frontend/src/lib/conversation-agent-roster.ts',
    '../../frontend/src/lib/conversation-agents-panel.ts',
    '../../frontend/src/hooks/useConversationAgentRoster.ts',
    '../../frontend/src/hooks/useRetainedAgentConfiguration.ts',
    '../../frontend/src/components/SharedConversation.tsx',
    '../../frontend/src/components/ConversationAgents.tsx',
    '../../frontend/src/components/ConversationAgents.css',
    '../../frontend/src/components/ComposerStatus.tsx',
    '../../frontend/src/components/ComposerStatus.css',
  ]) {
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
