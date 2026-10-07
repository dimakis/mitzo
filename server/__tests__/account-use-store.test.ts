import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AccountUseStore } from '../account-use-store.js';

const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai',
  profileRevision: 'route-1',
  model: 'luna',
};

it('persists successful use for the exact account route and currently allowed model', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-account-use-'));
  const path = join(directory, 'account-use.db');
  let store = new AccountUseStore(path);
  try {
    store.record(binding, 100);
    store.record({ ...binding, model: 'removed-model' }, 200);
    store.close();
    store = new AccountUseStore(path);
    expect(store.latest(binding, ['luna'])).toEqual({ model: 'luna', succeededAt: 100 });
    expect(store.latest({ ...binding, profileRevision: 'route-2' }, ['luna'])).toBeUndefined();
    expect(store.latest({ ...binding, provider: 'openai-codex' }, ['luna'])).toBeUndefined();
    expect(store.latest({ ...binding, accountId: 'personal' }, ['luna'])).toBeUndefined();
    expect(store.latest(binding, [])).toBeUndefined();
    store.record(binding, 50);
    expect(store.latest(binding, ['luna'])?.succeededAt).toBe(100);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
