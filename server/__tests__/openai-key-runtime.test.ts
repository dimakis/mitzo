import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIKeyOperationStore } from '../openai-key-operation-store.js';
import { createConnectionsRuntime } from '../connections-runtime.js';
it('keeps persisted key-replacement intent blocking admission when UI enrollment is disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openai-runtime-guard-'));
  const store = new OpenAIKeyOperationStore(join(directory, 'openai-key-operations.db'));
  store.begin({
    accountId: 'work',
    binding: 'binding',
    gatewayVersion: '10',
    keychainBeforeVersion: null,
  });
  store.close();
  const runtime = createConnectionsRuntime({
    directory,
    cli: 'not-executed',
    workspace: 'default',
    eligibleAccountIds: () => [],
    openAIKeyAccounts: () => [],
  });
  try {
    expect(runtime.openAIKeys).toBeUndefined();
    await expect(
      runtime.service.withAccountRuntime('work', async () => 'started'),
    ).rejects.toThrow();
    expect(runtime.assertOpenAIKeyReady).toBeTypeOf('function');
  } finally {
    runtime.closeOpenAIKeyManagement?.();
    runtime.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
