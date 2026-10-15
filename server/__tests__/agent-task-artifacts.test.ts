import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('binds assigned task authority, persistence and protocol to the reviewed runtime manifest', async () => {
  const artifacts: Record<string, string> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../agent-task-store.ts',
    '../agent-task-service.ts',
    '../agent-task-router.ts',
    '../agent-task-runtime.ts',
    '../symposium-custodian-protocol.ts',
    '../symposium-custodian-proxy.ts',
    '../../packages/protocol/src/agent-tasks.ts',
  ]) {
    const source = await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8');
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
