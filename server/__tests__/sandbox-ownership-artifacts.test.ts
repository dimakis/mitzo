import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
it('pins ownership review and managed batch UI in the reviewed runtime source closure', () => {
  const sources: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const path of [
    '../sandbox-ownership-review.ts',
    '../legacy-sandbox-deletion.ts',
    '../codex-conversation-store.ts',
    '../openshell-lifecycle-controller.ts',
    '../openshell-lifecycle-production.ts',
    '../openshell-warm-pool-router.ts',
    '../app.ts',
    '../../frontend/src/pages/SandboxesView.tsx',
    '../../frontend/src/types/sandboxes.ts',
    '../../frontend/src/components/SandboxBatchCleanup.tsx',
    '../../frontend/src/components/SandboxOwnershipReview.tsx',
  ]) {
    expect(sources[path], path).toBe(
      reviewedHandlerSourceFingerprint(readFileSync(resolve('server/connections', path), 'utf8')),
    );
  }
});
