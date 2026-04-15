import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { RepoConfig } from '../repo-config.js';

const TEST_BASE = join(tmpdir(), `mitzo-session-dirs-${process.pid}`);
const TEST_PROJECTS = join(TEST_BASE, 'projects');

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
};

const mockLoadRepoConfig = vi.fn((_repoPath?: string) => ({ ...mockConfig }));
vi.mock('../repo-config.js', () => ({
  loadRepoConfig: (repoPath: string) => mockLoadRepoConfig(repoPath),
}));

import { getSessionDirs, BASE_REPO } from '../chat.js';

let fakeTime = 100_000;
beforeEach(() => {
  mkdirSync(TEST_PROJECTS, { recursive: true });
  mockLoadRepoConfig.mockReturnValue({ ...mockConfig });
  // Force getRepoConfig cache invalidation — advance fake clock past the 5s TTL
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

    // Use a different child as the root so the parent (TEST_PROJECTS) is scanned
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

    // Should not throw
    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
  });

  it('handles config load failure gracefully', () => {
    mockLoadRepoConfig.mockImplementation(() => {
      throw new Error('config not loaded');
    });

    // Should not throw, should still have BASE_REPO
    const dirs = getSessionDirs();
    expect(dirs[0]).toBe(BASE_REPO);
    expect(dirs.length).toBeGreaterThanOrEqual(1);
  });

  it('includes legacy session dirs (<BASE_REPO>-sessions/session-*)', () => {
    const legacyDir = `${BASE_REPO}-sessions`;
    mkdirSync(join(legacyDir, 'session-abc'), { recursive: true });
    mkdirSync(join(legacyDir, 'session-def'), { recursive: true });
    // Non-matching entry should be ignored
    mkdirSync(join(legacyDir, 'other'), { recursive: true });

    const dirs = getSessionDirs();
    expect(dirs).toContain(join(legacyDir, 'session-abc'));
    expect(dirs).toContain(join(legacyDir, 'session-def'));
    expect(dirs).not.toContain(join(legacyDir, 'other'));

    rmSync(legacyDir, { recursive: true, force: true });
  });

  it('multiple roots sharing the same parent only scan parent once', () => {
    const projA = join(TEST_PROJECTS, 'proj-a');
    const projB = join(TEST_PROJECTS, 'proj-b');
    const projC = join(TEST_PROJECTS, 'proj-c');
    mkdirSync(join(projA, '.git'), { recursive: true });
    mkdirSync(join(projB, '.git'), { recursive: true });
    mkdirSync(join(projC, '.claude'), { recursive: true });

    // Two roots under the same parent — parent should only be scanned once
    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [
        { label: 'A', path: projA },
        { label: 'B', path: projB },
      ],
    });

    const dirs = getSessionDirs();
    // All siblings with markers should appear, each exactly once
    expect(dirs).toContain(projA);
    expect(dirs).toContain(projB);
    expect(dirs).toContain(projC);
    expect(dirs.filter((d) => d === projA).length).toBe(1);
    expect(dirs.filter((d) => d === projB).length).toBe(1);
    expect(dirs.filter((d) => d === projC).length).toBe(1);
  });
});
