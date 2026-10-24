import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import {
  createFreshTelosDatabaseFiles,
  type TelosDatabaseFiles,
} from '@mitzo/protocol/telos-sqlite-owners';

/** Run BEFORE any fixture/App EventStore, TaskStore or canonical connection.
 * Uses the actual exclusive creator and accepted fixture DDL on the SAME file.
 * It never writes birth/certificate bytes, enrolls old files or supplies a permit.
 * Actual App initialization still installs/checks its original owners itself. */
export function initializeFreshPrivateAppFiles(
  repoRoot: string,
  canonicalPath: string,
  seed: (canonical: Database.Database) => void,
): TelosDatabaseFiles {
  const realRoot = realpathSync(repoRoot);
  const underTemp = relative(realpathSync(tmpdir()), realRoot);
  if (
    realRoot !== repoRoot ||
    !basename(realRoot).startsWith('s9-coherent-') ||
    underTemp === '..' ||
    underTemp.startsWith('..' + sep) ||
    isAbsolute(underTemp)
  ) {
    throw Error('A caller-created real s9-coherent temporary fixture root is required');
  }
  const inside = relative(repoRoot, canonicalPath);
  if (
    !isAbsolute(repoRoot) ||
    !isAbsolute(canonicalPath) ||
    inside === '..' ||
    inside.startsWith('..' + sep) ||
    isAbsolute(inside)
  )
    throw Error('Private canonical file must be under the selected fixture root');
  const files = {
    canonical: canonicalPath,
    events: join(repoRoot, '.mitzo/events.db'),
    tasks: join(repoRoot, '.mitzo/tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  const canonical = new Database(files.canonical, { fileMustExist: true });
  try {
    canonical.pragma('journal_mode=WAL');
    canonical.exec(
      readFileSync(
        new URL(
          '../../../../server/__tests__/fixtures/telos-canonical-3077b7b4/fresh.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    seed(canonical);
  } finally {
    canonical.close();
  }
  return files;
}
