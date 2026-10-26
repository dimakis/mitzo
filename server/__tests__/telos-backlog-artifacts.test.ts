import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';
it('pins backlog execution, schemas and collection hydration to the reviewed runtime manifest', async () => {
  const artifacts: Readonly<Record<string, string>> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../telos-backlog-tools.ts',
    '../__tests__/telos-backlog.test.ts',
    '../__tests__/telos-backlog-tools.test.ts',
    '../../packages/protocol/src/telos-backlog.ts',
    '../../frontend/src/test-utils/telos-record-batch.ts',
  ]) {
    expect(artifacts[file], file).toBe(
      reviewedHandlerSourceFingerprint(
        await readFile(new URL(`../connections/${file}`, import.meta.url), 'utf8'),
      ),
    );
  }
});
