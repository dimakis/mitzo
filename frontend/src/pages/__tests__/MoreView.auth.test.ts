import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('MoreView logout ordering', () => {
  it('starts bounded local logout before awaiting native credential cleanup', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'MoreView.tsx'), 'utf8');

    expect(source).toContain('const logoutRequest = logout();');
    expect(source).toContain(
      'Promise.allSettled([logoutRequest, deleteCredentials(), clearWatchToken()])',
    );
  });
});
