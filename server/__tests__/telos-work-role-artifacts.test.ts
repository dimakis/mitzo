import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('registers the ordinary role setup, host scope, advisor save and shared UI owners', () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  const files = [
    '../task-orchestrator.ts',
    '../task-store.ts',
    '../task-tools.ts',
    '../task-context.ts',
    '../telos-work-delegation.ts',
    '../telos-work-delegation-host.ts',
    '../telos-work-command-scope.ts',
    '../telos-work-execution-authority.ts',
    '../telos-work-tools.ts',
    '../telos-worker-task-tools.ts',
    '../task-mcp-server.ts',
    '../../packages/protocol/src/telos-work-delegation.ts',
    '../../frontend/src/components/TelosWorkerReceiptCard.tsx',
    '../../frontend/src/components/TelosWorkerReceiptCard.css',
    '../telos-work-role-context.ts',
    '../telos-work-role-host.ts',
    '../telos-work-role-review.ts',
    '../telos-work-role-setup.ts',
    '../telos-work-advisor-draft.ts',
    '../../packages/protocol/src/telos-work-role-context.ts',
    '../../packages/protocol/src/telos-work-advisor.ts',
    '../../frontend/src/components/TelosRoleSetup.tsx',
    '../../frontend/src/components/TelosLinkedContext.tsx',
    '../../frontend/src/components/TelosItemRoleEntries.tsx',
    '../../frontend/src/components/TelosAdvisorDraft.tsx',
    '../../frontend/src/components/RepositoryChatPicker.css',
    '../../frontend/src/hooks/useTelosRoleSetup.ts',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, new URL('../connections/', import.meta.url)), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
