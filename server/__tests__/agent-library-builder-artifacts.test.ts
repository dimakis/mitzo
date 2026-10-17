import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it.each([
  '../session-agent-task-tools.ts',
  '../../frontend/src/components/AgentTaskProposal.tsx',
  '../agent-task-store.ts',
  '../agent-task-service.ts',
  '../agent-task-router.ts',
  '../symposium-profile-proposals.ts',
  '../symposium-profile-proposal-routes.ts',
  '../../packages/protocol/src/agent-tasks.ts',
  '../../packages/protocol/src/profile-builder.ts',
  '../../packages/protocol/src/source-snapshot.ts',
  '../../packages/protocol/src/agent-library-editable.ts',
  '../source-snapshot-context.ts',
  '../codex-rollover-context.ts',
  '../../frontend/src/lib/agent-builder-chat.ts',
  '../../frontend/src/lib/agent-library-working-copy.ts',
  '../../frontend/src/components/AgentLibraryChatSource.tsx',
  '../../frontend/src/components/ContextInjectionDisclosure.tsx',
  '../../frontend/src/components/SymposiumProfileProposals.tsx',
])(
  'pins the ordinary Builder source/review dependency %s in the runtime manifest',
  async (file) => {
    const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  },
);
