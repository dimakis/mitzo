import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

import { getSessionDirs, BASE_REPO } from '../chat.js';

describe('getSessionDirs', () => {
  it('always includes BASE_REPO as first entry', () => {
    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
  });

  it('returns only BASE_REPO when no legacy dir exists', () => {
    const dirs = getSessionDirs();
    expect(dirs).toEqual([BASE_REPO]);
  });

  it('includes legacy session dirs (<BASE_REPO>-sessions/session-*)', () => {
    const legacyDir = `${BASE_REPO}-sessions`;
    mkdirSync(join(legacyDir, 'session-abc'), { recursive: true });
    mkdirSync(join(legacyDir, 'session-def'), { recursive: true });
    mkdirSync(join(legacyDir, 'other'), { recursive: true });

    try {
      const dirs = getSessionDirs();
      expect(dirs).toContain(join(legacyDir, 'session-abc'));
      expect(dirs).toContain(join(legacyDir, 'session-def'));
      expect(dirs).not.toContain(join(legacyDir, 'other'));
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
