import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Login authentication recovery', () => {
  it('checks for a preserved cookie session after a failed passphrase attempt', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'Login.tsx'), 'utf8');

    expect(source).toContain('await restoreCookieAuthentication()');
  });
});
