import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIKeyOperationStore } from '../openai-key-operation-store.js';
import { assertOpenAIKeyController } from '../openai-key-controller.js';
it('blocks owned accounts when the entire Connections controller is absent, while preserving unrelated accounts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openai-controller-'));
  const store = new OpenAIKeyOperationStore(join(directory, 'openai-key-operations.db'));
  try {
    store.begin({
      accountId: 'work',
      binding: 'binding',
      gatewayVersion: '1',
      keychainBeforeVersion: null,
    });
    expect(() => assertOpenAIKeyController('work', directory, false)).toThrow(
      'OpenAI credential management must be restored',
    );
    expect(() => assertOpenAIKeyController('other', directory, false)).not.toThrow();
    expect(() => assertOpenAIKeyController('work', directory, true)).not.toThrow();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
