import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
import { openLease, closeLease } from '@mitzo/sqlite-file-owner';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosItemStore } from '../telos-item-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it.each(['Work', 'Item', 'Artifact'] as const)(
  'closes the actual retained %s owner when its initial connection pragma throws',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'telos-constructor-cleanup-'));
    roots.push(root);
    const files = {
      canonical: join(root, 'canonical.db'),
      events: join(root, '.mitzo/events.db'),
      tasks: join(root, '.mitzo/tasks.db'),
    };
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('TELOS_DB_PATH', files.canonical);
    createFreshTelosDatabaseFiles(files);
    const seed = new Database(files.canonical);
    seed.pragma('journal_mode=WAL');
    seed.exec(
      readFileSync(
        new URL('./fixtures/telos-canonical-3077b7b4/fresh.sql', import.meta.url),
        'utf8',
      ),
    );
    seed.close();
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => {
      throw new Error('Injected initial actual-connection pragma failure');
    });
    try {
      expect(() =>
        kind === 'Work'
          ? new TelosWorkStore(files.canonical, { ordinaryConversation: () => true })
          : kind === 'Item'
            ? new TelosItemStore(files.canonical)
            : new TelosArtifactStore(files.canonical),
      ).toThrow('Injected initial actual-connection pragma failure');
    } finally {
      pragma.mockRestore();
    }
    // An actual independent native admission observes that the failed owner really
    // closed its final connection and released its descriptor family, not a flag.
    const lease = openLease(join(root, '.telos-file-owners/exclusion'));
    closeLease(lease);
  },
);
