import { expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccountStore } from '../claude-account-store.js';
it('keeps independent accounts and accepts new logins after 500 historical attempts', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-many-')));
  const store = new ClaudeAccountStore(join(root, 'accounts'));
  try {
    let first = '';
    for (let index = 0; index < 70; index++) {
      const row = store.reserve('operator', Date.now() + 60_000, {
        requestId: crypto.randomUUID(),
        label: `Claude ${index}`,
      });
      first ||= row.accountId;
      store.connected(row, {
        email: `person-${index}@example.test`,
        planType: index % 2 ? 'pro' : 'max',
      });
    }
    for (let index = 0; index < 440; index++) {
      const row = store.reserve('operator', Date.now() + 60_000, {
        requestId: crypto.randomUUID(),
        accountId: first,
        label: 'Claude 0',
      });
      store.update({ ...row, state: 'cancelled' });
    }
    expect(store.accounts()).toHaveLength(70);
    expect(new Set(store.accounts().map((row) => store.config(row.id))).size).toBe(70);
    expect(store.accounts()[69].email).toBe('person-69@example.test');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
