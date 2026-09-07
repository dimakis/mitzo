import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAliases } from '../account-aliases.js';
it('persists display aliases independently of account identity and supports reset', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-alias-'));
  const file = join(root, 'aliases.json');
  try {
    const aliases = new AccountAliases(file);
    expect(aliases.label('a', 'Original')).toBe('Original');
    aliases.set('a', '  Personal Pro  ');
    expect(new AccountAliases(file).label('a', 'Original')).toBe('Personal Pro');
    expect(aliases.label('b', 'Work')).toBe('Work');
    expect(() => aliases.set('a', 'x'.repeat(81))).toThrow();
    aliases.set('a', '');
    expect(aliases.label('a', 'Original')).toBe('Original');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
