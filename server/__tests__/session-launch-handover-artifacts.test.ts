import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('retains source pins for coordinator tool qualification, handover delivery and their consumers', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../session-launch-tools-selection.ts',
    '../session-launch-diagnostics.ts',
    '../session-launch-runtime.ts',
    '../session-launch-routes.ts',
    '../session-launch-service.ts',
    '../session-launch-store.ts',
    '../session-launch-tools.ts',
    '../__tests__/session-launch-handover.test.ts',
    '../__tests__/session-launch-tools-selection.test.ts',
    '../__tests__/session-launch-handover-artifacts.test.ts',
    '../../packages/protocol/src/session-launch.ts',
    '../../frontend/src/lib/share-file.ts',
    '../../frontend/src/lib/__tests__/session-handover-native.test.ts',
    '../../frontend/src/components/SessionLaunchCards.tsx',
    '../../tests/offline/session-launch-recovery.spec.ts',
    '../../docs/features/agent-session-launch.md',
  ]) {
    expect(Object.hasOwn(artifacts, file), file).toBe(true);
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(reviewedHandlerSourceFingerprint(source), file).toBe(artifacts[file]);
  }
});
