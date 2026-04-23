import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RepoConfig } from '../repo-config.js';

const TEST_BASE = join(tmpdir(), `mitzo-session-dirs-${process.pid}`);
const TEST_PROJECTS = join(TEST_BASE, 'projects');
const TEST_CLAUDE_PROJECTS = join(TEST_BASE, 'claude-projects');

const mockConfig: RepoConfig = {
  quickActions: [],
  venvPaths: [],
  resolvedVenvPaths: [],
  allowedPaths: [],
  roots: [],
  toolTierOverrides: {},
  inboxPath: '',
  resolvedInboxPath: '',
  repos: {},
  contextBlocks: {},
  isolation: true,
  runtimeSymlinks: [],
};

const mockLoadRepoConfig = vi.fn((_repoPath?: string) => ({ ...mockConfig }));
vi.mock('../repo-config.js', () => ({
  loadRepoConfig: (repoPath: string) => mockLoadRepoConfig(repoPath),
}));

import { getSessionDirs, BASE_REPO } from '../chat.js';

let fakeTime = 100_000;
beforeEach(() => {
  mkdirSync(TEST_PROJECTS, { recursive: true });
  mkdirSync(TEST_CLAUDE_PROJECTS, { recursive: true });
  mockLoadRepoConfig.mockReturnValue({ ...mockConfig });
  fakeTime += 10_000;
  vi.useFakeTimers({ now: fakeTime });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(TEST_BASE, { recursive: true, force: true });
  mockLoadRepoConfig.mockReset();
});

describe('getSessionDirs', () => {
  it('always includes BASE_REPO as first entry', () => {
    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
  });

  it('includes explicitly configured repos', () => {
    const repoA = join(TEST_BASE, 'repo-a');
    mkdirSync(repoA, { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      repos: { 'repo-a': repoA },
    });

    const dirs = getSessionDirs();
    expect(dirs).toContain(repoA);
  });

  it('discovers sibling dirs with .git from roots parents', () => {
    const projA = join(TEST_PROJECTS, 'proj-a');
    mkdirSync(join(projA, '.git'), { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'ProjA', path: projA }],
    });

    const dirs = getSessionDirs();
    expect(dirs).toContain(projA);
  });

  it('discovers sibling dirs with .claude (no .git)', () => {
    const projB = join(TEST_PROJECTS, 'proj-b');
    mkdirSync(join(projB, '.claude'), { recursive: true });

    const otherProj = join(TEST_PROJECTS, 'other');
    mkdirSync(otherProj, { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'Other', path: otherProj }],
    });

    const dirs = getSessionDirs();
    expect(dirs).toContain(projB);
  });

  it('skips non-directory entries in parent dirs', () => {
    writeFileSync(join(TEST_PROJECTS, 'not-a-dir'), 'hello');

    const projDir = join(TEST_PROJECTS, 'proj');
    mkdirSync(projDir, { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'Proj', path: projDir }],
    });

    const dirs = getSessionDirs();
    expect(dirs).not.toContain(join(TEST_PROJECTS, 'not-a-dir'));
  });

  it('skips directories without .git or .claude', () => {
    const plainDir = join(TEST_PROJECTS, 'no-markers');
    mkdirSync(plainDir, { recursive: true });

    const rootDir = join(TEST_PROJECTS, 'root');
    mkdirSync(rootDir, { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'Root', path: rootDir }],
    });

    const dirs = getSessionDirs();
    expect(dirs).not.toContain(plainDir);
  });

  it('deduplicates repos that appear in both repos and root siblings', () => {
    const projA = join(TEST_PROJECTS, 'proj-a');
    mkdirSync(join(projA, '.git'), { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'ProjA', path: projA }],
      repos: { 'proj-a': projA },
    });

    const dirs = getSessionDirs();
    const count = dirs.filter((d) => d === projA).length;
    expect(count).toBe(1);
  });

  it('handles missing parent dirs gracefully', () => {
    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'Missing', path: '/nonexistent/path/xyz/child' }],
    });

    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
  });

  it('handles config load failure gracefully', () => {
    mockLoadRepoConfig.mockImplementation(() => {
      throw new Error('config not loaded');
    });

    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
    expect(dirs.length).toBeGreaterThanOrEqual(1);
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

  it('multiple roots sharing the same parent only scan parent once', () => {
    const projA = join(TEST_PROJECTS, 'proj-a');
    const projB = join(TEST_PROJECTS, 'proj-b');
    const projC = join(TEST_PROJECTS, 'proj-c');
    mkdirSync(join(projA, '.git'), { recursive: true });
    mkdirSync(join(projB, '.git'), { recursive: true });
    mkdirSync(join(projC, '.claude'), { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [
        { label: 'A', path: projA },
        { label: 'B', path: projB },
      ],
    });

    const dirs = getSessionDirs();
    expect(dirs).toContain(projA);
    expect(dirs).toContain(projB);
    expect(dirs).toContain(projC);
    expect(dirs.filter((d) => d === projA).length).toBe(1);
    expect(dirs.filter((d) => d === projB).length).toBe(1);
    expect(dirs.filter((d) => d === projC).length).toBe(1);
  });

  it('discovers worktree sessions from ~/.claude/projects/', () => {
    const encoded = BASE_REPO.replace(/\//g, '-');
    const wtDir1 = `${encoded}--claude-worktrees-2026-04-15-abc123`;
    const wtDir2 = `${encoded}--claude-worktrees-2026-04-14-def456`;
    mkdirSync(join(TEST_CLAUDE_PROJECTS, wtDir1), { recursive: true });
    mkdirSync(join(TEST_CLAUDE_PROJECTS, wtDir2), { recursive: true });

    const dirs = getSessionDirs({ claudeProjectsRoot: TEST_CLAUDE_PROJECTS });
    expect(dirs).toContain(`${BASE_REPO}/.claude/worktrees/2026-04-15-abc123`);
    expect(dirs).toContain(`${BASE_REPO}/.claude/worktrees/2026-04-14-def456`);
  });

  it('does not include non-worktree dirs from ~/.claude/projects/', () => {
    const encoded = BASE_REPO.replace(/\//g, '-');
    // Base repo dir and unrelated repo — neither should add entries
    mkdirSync(join(TEST_CLAUDE_PROJECTS, encoded), { recursive: true });
    mkdirSync(join(TEST_CLAUDE_PROJECTS, '-Users-someone-other-repo'), { recursive: true });

    const dirs = getSessionDirs({ claudeProjectsRoot: TEST_CLAUDE_PROJECTS });
    const dirsWithoutBaseAndLegacy = dirs.filter((d) => d !== BASE_REPO);
    expect(dirsWithoutBaseAndLegacy).toHaveLength(0);
  });

  it('deduplicates worktree dirs already found via other methods', () => {
    const encoded = BASE_REPO.replace(/\//g, '-');
    const wtDir = `${encoded}--claude-worktrees-2026-04-15-abc123`;
    mkdirSync(join(TEST_CLAUDE_PROJECTS, wtDir), { recursive: true });

    const dirs = getSessionDirs({ claudeProjectsRoot: TEST_CLAUDE_PROJECTS });
    const wtPath = `${BASE_REPO}/.claude/worktrees/2026-04-15-abc123`;
    expect(dirs.filter((d) => d === wtPath)).toHaveLength(1);
  });

  it('handles missing ~/.claude/projects/ gracefully', () => {
    const dirs = getSessionDirs({ claudeProjectsRoot: '/nonexistent/path' });
    expect(dirs[0]).toBe(BASE_REPO);
  });
});
