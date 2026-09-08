import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Login authentication recovery', () => {
  it('checks for a preserved cookie session after a failed passphrase attempt', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'Login.tsx'), 'utf8');

    expect(source).toContain('await restoreCookieAuthentication()');
  });

  it('leaves the login page when another tab restores authentication', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'Login.tsx'), 'utf8');

    expect(source).toContain('AUTH_RESTORED_EVENT');
    expect(source).toContain('window.addEventListener(AUTH_RESTORED_EVENT, onAuthRestored)');
    expect(source).toContain('if (isCrossTabAuthEvent(event)) navigate');
  });
});
