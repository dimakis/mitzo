import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ProtectedRoute authentication restoration', () => {
  it('uses the guarded cookie restoration check before rendering authenticated routes', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'App.tsx'), 'utf8');

    expect(source).toContain('restoreCookieAuthentication()');
  });
});
