import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import yaml from 'js-yaml';

export interface SessionIndexRepo {
  name: string;
  worktree: string;
  branch: string;
}

export interface SessionIndexEntry {
  id: string;
  sha?: string;
  sdk_session_id?: string;
  date?: string;
  initial_title?: string;
  last_title?: string;
  repos?: SessionIndexRepo[];
  status?: 'active' | 'closed' | 'abandoned';
  has_uncommitted?: boolean;
  closeout_summary?: string;
  tokens_used?: number;
  cost_usd?: number;
}

interface IndexFile {
  sessions: SessionIndexEntry[];
}

function indexPath(repoPath: string): string {
  return join(repoPath, '.claude', 'sessions', 'index.yaml');
}

/**
 * Read the session index from disk. Returns [] if the file doesn't exist or is empty.
 */
export function readIndex(repoPath: string): SessionIndexEntry[] {
  const path = indexPath(repoPath);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];

  const parsed = yaml.load(raw) as IndexFile | null;
  return parsed?.sessions ?? [];
}

/**
 * Insert or update a session index entry. Merge semantics: fields in the
 * partial entry overwrite matching fields; unset fields are preserved.
 * The `id` field is used as the merge key.
 */
export function upsertEntry(
  repoPath: string,
  partial: Partial<SessionIndexEntry> & { id: string },
): void {
  const entries = readIndex(repoPath);
  const idx = entries.findIndex((e) => e.id === partial.id);

  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...partial };
  } else {
    entries.push(partial as SessionIndexEntry);
  }

  const path = indexPath(repoPath);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const out: IndexFile = { sessions: entries };
  writeFileSync(path, yaml.dump(out, { lineWidth: 120, noRefs: true }));
}

/**
 * Register a new session in the index with a skeleton entry.
 * No-op if the session ID already exists (idempotent for resumed sessions).
 */
export function registerSession(
  repoPath: string,
  wtId: string,
  worktreePaths: Map<string, { path: string; wtId: string }>,
  branch: string,
): void {
  const existing = readIndex(repoPath);
  if (existing.some((e) => e.id === wtId)) return;

  const sha = wtId.includes('-') ? wtId.split('-').pop()! : wtId;
  const date = wtId.slice(0, 10); // YYYY-MM-DD prefix

  const repos = Array.from(worktreePaths.entries()).map(([name, { path }]) => ({
    name,
    worktree: path,
    branch,
  }));

  upsertEntry(repoPath, {
    id: wtId,
    sha,
    date,
    status: 'active',
    repos,
  });
}

/**
 * Update session title. Sets `initial_title` on first call (when not yet set),
 * `last_title` on subsequent calls. `initial_title` is frozen after first write.
 */
export function updateSessionTitle(repoPath: string, wtId: string, title: string): void {
  const entries = readIndex(repoPath);
  const entry = entries.find((e) => e.id === wtId);
  if (!entry) return;

  if (!entry.initial_title) {
    upsertEntry(repoPath, { id: wtId, initial_title: title });
  } else {
    upsertEntry(repoPath, { id: wtId, last_title: title });
  }
}

/**
 * Finalize a session's closeout state in the index.
 */
export function finalizeCloseout(
  repoPath: string,
  wtId: string,
  fields: {
    status: 'closed' | 'abandoned';
    tokens_used?: number;
    cost_usd?: number;
    has_uncommitted?: boolean;
    closeout_summary?: string;
  },
): void {
  const entries = readIndex(repoPath);
  if (!entries.some((e) => e.id === wtId)) return;

  upsertEntry(repoPath, { id: wtId, ...fields });
}

/**
 * Set the SDK session ID on an existing index entry.
 */
export function updateSessionSdkId(repoPath: string, wtId: string, sdkSessionId: string): void {
  const entries = readIndex(repoPath);
  if (!entries.some((e) => e.id === wtId)) return;

  upsertEntry(repoPath, { id: wtId, sdk_session_id: sdkSessionId });
}
