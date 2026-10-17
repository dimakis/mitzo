import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
it('pins the full warm pool ownership, operator API, host and UI source closure', () => {
  const artifacts = reviewedHandlerSourceArtifacts as Record<string, string>;
  for (const path of [
    '../openshell-runtime.ts',
    '../openshell-warm-pool.ts',
    '../openshell-warm-pool-runtime.ts',
    '../openshell-warm-pool-binding.ts',
    '../openshell-warm-pool-router.ts',
    '../openshell-warm-pool-host.ts',
    '../openshell-lifecycle-service.ts',
    '../session-removal.ts',
    '../sandbox-inventory.ts',
    '../app.ts',
    '../index.ts',
    '../../frontend/src/pages/SandboxesView.tsx',
    '../../frontend/src/pages/SandboxesView.css',
    '../../frontend/src/types/sandboxes.ts',
    '../../frontend/src/components/SessionRemovalDialog.tsx',
    '../../frontend/src/components/SessionPanel.tsx',
    '../../frontend/src/pages/SessionList.tsx',
    '../../frontend/src/hooks/useSessionList.ts',
  ]) {
    expect(artifacts[path], path).toBe(
      reviewedHandlerSourceFingerprint(
        readFileSync(resolve(import.meta.dirname, '../connections', path), 'utf8'),
      ),
    );
  }
});
