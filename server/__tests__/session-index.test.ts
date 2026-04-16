import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readIndex,
  upsertEntry,
  registerSession,
  updateSessionTitle,
  updateSessionSdkId,
} from '../session-index.js';

describe('session-index', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'session-index-test-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  const INDEX_PATH = (rp: string) => join(rp, '.claude', 'sessions', 'index.yaml');

  describe('readIndex', () => {
    it('returns empty array when index file does not exist', () => {
      expect(readIndex(repoPath)).toEqual([]);
    });

    it('returns empty array when file exists but is empty', () => {
      const dir = join(repoPath, '.claude', 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(INDEX_PATH(repoPath), '');
      expect(readIndex(repoPath)).toEqual([]);
    });

    it('reads existing entries from YAML', () => {
      const dir = join(repoPath, '.claude', 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        INDEX_PATH(repoPath),
        `sessions:
  - id: "2026-04-16-abc123"
    sha: "abc123"
    date: "2026-04-16"
    status: active
`,
      );

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('2026-04-16-abc123');
      expect(entries[0].sha).toBe('abc123');
      expect(entries[0].status).toBe('active');
    });
  });

  describe('upsertEntry', () => {
    it('creates the directory and file if they do not exist', () => {
      upsertEntry(repoPath, {
        id: '2026-04-16-abc123',
        sha: 'abc123',
        date: '2026-04-16',
        status: 'active',
        repos: [],
      });

      const content = readFileSync(INDEX_PATH(repoPath), 'utf-8');
      expect(content).toContain('2026-04-16-abc123');
    });

    it('adds a new entry when no entries exist', () => {
      upsertEntry(repoPath, {
        id: '2026-04-16-abc123',
        sha: 'abc123',
        date: '2026-04-16',
        status: 'active',
        repos: [],
      });

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('2026-04-16-abc123');
    });

    it('updates an existing entry by id (merge semantics)', () => {
      upsertEntry(repoPath, {
        id: '2026-04-16-abc123',
        sha: 'abc123',
        date: '2026-04-16',
        status: 'active',
        repos: [],
      });

      upsertEntry(repoPath, {
        id: '2026-04-16-abc123',
        initial_title: 'Email draft for Cat',
        status: 'active',
      });

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].initial_title).toBe('Email draft for Cat');
      expect(entries[0].sha).toBe('abc123'); // preserved from original
    });

    it('appends a second entry without overwriting the first', () => {
      upsertEntry(repoPath, {
        id: 'session-1',
        sha: 'aaa',
        date: '2026-04-15',
        status: 'active',
        repos: [],
      });

      upsertEntry(repoPath, {
        id: 'session-2',
        sha: 'bbb',
        date: '2026-04-16',
        status: 'active',
        repos: [],
      });

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.id)).toContain('session-1');
      expect(entries.map((e) => e.id)).toContain('session-2');
    });

    it('updates status and closeout_summary on closeout', () => {
      upsertEntry(repoPath, {
        id: 'session-1',
        sha: 'aaa',
        date: '2026-04-16',
        status: 'active',
        repos: [],
      });

      upsertEntry(repoPath, {
        id: 'session-1',
        status: 'closed',
        closeout_summary: 'Drafted email. Needs review.',
        tokens_used: 45200,
        cost_usd: 0.34,
        has_uncommitted: false,
      });

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('closed');
      expect(entries[0].closeout_summary).toBe('Drafted email. Needs review.');
      expect(entries[0].tokens_used).toBe(45200);
      expect(entries[0].cost_usd).toBe(0.34);
      expect(entries[0].has_uncommitted).toBe(false);
    });

    it('preserves repos array through updates', () => {
      const repos = [
        { name: 'mgmt', worktree: '.claude/worktrees/session-1', branch: 'session/session-1' },
      ];

      upsertEntry(repoPath, {
        id: 'session-1',
        sha: 'aaa',
        date: '2026-04-16',
        status: 'active',
        repos,
      });

      upsertEntry(repoPath, {
        id: 'session-1',
        last_title: 'Updated title',
      });

      const entries = readIndex(repoPath);
      expect(entries[0].repos).toEqual(repos);
      expect(entries[0].last_title).toBe('Updated title');
    });
  });

  describe('registerSession', () => {
    it('creates a skeleton entry with id, sha, date, repos, status=active', () => {
      const worktrees = new Map([
        [
          'primary',
          { path: '/tmp/repo/.claude/worktrees/2026-04-16-abc123', wtId: '2026-04-16-abc123' },
        ],
        [
          'mitzo',
          { path: '/tmp/mitzo/.claude/worktrees/2026-04-16-abc123', wtId: '2026-04-16-abc123' },
        ],
      ]);

      registerSession(repoPath, '2026-04-16-abc123', worktrees, 'session/2026-04-16-abc123');

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('2026-04-16-abc123');
      expect(entries[0].sha).toBe('abc123');
      expect(entries[0].date).toBe('2026-04-16');
      expect(entries[0].status).toBe('active');
      expect(entries[0].repos).toHaveLength(2);
      expect(entries[0].repos![0].name).toBe('primary');
      expect(entries[0].repos![1].name).toBe('mitzo');
    });

    it('does not overwrite an existing entry', () => {
      upsertEntry(repoPath, {
        id: '2026-04-16-abc123',
        sha: 'abc123',
        date: '2026-04-16',
        status: 'closed',
        initial_title: 'Already done',
      });

      registerSession(repoPath, '2026-04-16-abc123', new Map(), 'main');

      const entries = readIndex(repoPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('closed'); // not overwritten
      expect(entries[0].initial_title).toBe('Already done');
    });
  });

  describe('updateSessionTitle', () => {
    it('sets initial_title on first call', () => {
      upsertEntry(repoPath, { id: 'sess-1', status: 'active' });

      updateSessionTitle(repoPath, 'sess-1', 'Email draft');

      const entries = readIndex(repoPath);
      expect(entries[0].initial_title).toBe('Email draft');
      expect(entries[0].last_title).toBeUndefined();
    });

    it('sets last_title on subsequent calls (initial_title frozen)', () => {
      upsertEntry(repoPath, { id: 'sess-1', status: 'active', initial_title: 'First title' });

      updateSessionTitle(repoPath, 'sess-1', 'Updated title');

      const entries = readIndex(repoPath);
      expect(entries[0].initial_title).toBe('First title'); // frozen
      expect(entries[0].last_title).toBe('Updated title');
    });

    it('is a no-op if session does not exist in index', () => {
      updateSessionTitle(repoPath, 'nonexistent', 'Some title');
      expect(readIndex(repoPath)).toEqual([]);
    });
  });

  describe('updateSessionSdkId', () => {
    it('sets sdk_session_id on existing entry', () => {
      upsertEntry(repoPath, { id: 'sess-1', status: 'active' });

      updateSessionSdkId(repoPath, 'sess-1', 'sdk-abc-123');

      const entries = readIndex(repoPath);
      expect(entries[0].sdk_session_id).toBe('sdk-abc-123');
    });

    it('is a no-op if session does not exist', () => {
      updateSessionSdkId(repoPath, 'nonexistent', 'sdk-abc');
      expect(readIndex(repoPath)).toEqual([]);
    });
  });
});
