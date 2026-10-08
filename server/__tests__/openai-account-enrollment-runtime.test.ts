import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIAccountEnrollmentStore } from '../openai-account-enrollment.js';
import { createConnectionsRuntime } from '../connections-runtime.js';
it('retains admission fencing with enrollment UI disabled and preserves unrelated accounts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'enrollment-runtime-'));
  const database = join(directory, 'enrollment', 'accounts.db');
  const store = new OpenAIAccountEnrollmentStore(database);
  const { row } = store.reserve(
    {
      requestId: randomUUID(),
      label: 'New Work',
      projectLabel: 'Declared work project',
      controllerBinding: 'a'.repeat(64),
    },
    [],
  );
  store.close();
  const runtime = createConnectionsRuntime({
    directory,
    cli: 'must-not-execute',
    workspace: 'default',
    eligibleAccountIds: () => [],
    openAIKeyAccounts: () => [],
    openAIEnrollmentDatabase: database,
    openAIAccountEnrollmentEnabled: false,
  });
  try {
    expect(runtime.openAIAccounts).toBeUndefined();
    expect(runtime.openAIEnrollmentAuthority?.list()).toMatchObject([
      { id: row.accountId, state: 'needs_attention' },
    ]);
    await expect(
      runtime.service.withAccountRuntime(row.accountId, async () => 'must not run'),
    ).rejects.toThrow('needs attention');
    await expect(
      runtime.service.withAccountRuntime('legacy-personal', async () => 'legacy permitted'),
    ).resolves.toBe('legacy permitted');
    await expect(
      runtime.assertOpenAIKeyReady?.('legacy-work', AbortSignal.timeout(1000)),
    ).resolves.toBeUndefined();
  } finally {
    runtime.closeOpenAIKeyManagement?.();
    runtime.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
