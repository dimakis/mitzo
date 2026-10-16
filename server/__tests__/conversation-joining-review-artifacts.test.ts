import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins the frozen joining review and its exact-operation/dialog/motion owners', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../../frontend/src/components/ConversationAgents.tsx',
    '../../frontend/src/components/ConversationAgents.css',
    '../../frontend/src/components/ConversationJoiningReview.tsx',
    '../../frontend/src/components/HomeDialog.tsx',
    '../../frontend/src/components/UiIcon.tsx',
    '../../frontend/src/hooks/useConversationJoiningReview.ts',
    '../../frontend/src/lib/conversation-joining-review.ts',
    '../../frontend/src/lib/browser-crypto.ts',
    '../../frontend/src/types/account-selection.ts',
    '../../frontend/src/styles/home.css',
    '../../frontend/src/styles/tokens.css',
    '../../frontend/src/hooks/useMotionPresence.ts',
    '../../frontend/src/hooks/useReducedMotion.ts',
    '../../frontend/src/lib/motion.ts',
    '../../packages/protocol/src/collaboration-conversation.ts',
  ]) {
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
