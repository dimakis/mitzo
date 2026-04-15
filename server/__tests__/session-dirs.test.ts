import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
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

  it('does NOT include configured repos (SDK discovers via BASE_REPO)', () => {
    const repoA = join(TEST_BASE, 'repo-a');
    mkdirSync(repoA, { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      repos: { 'repo-a': repoA },
    });

    const dirs = getSessionDirs();
    expect(dirs).not.toContain(repoA);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(BASE_REPO);
  });

  it('does NOT discover sibling dirs from roots', () => {
    const projA = join(TEST_PROJECTS, 'proj-a');
    mkdirSync(join(projA, '.git'), { recursive: true });

    mockLoadRepoConfig.mockReturnValue({
      ...mockConfig,
      roots: [{ label: 'ProjA', path: projA }],
    });

    const dirs = getSessionDirs();
    expect(dirs).not.toContain(projA);
  });

  it('includes legacy session dirs (<BASE_REPO>-sessions/session-*)', () => {
    const legacyDir = `${BASE_REPO}-sessions`;
    mkdirSync(join(legacyDir, 'session-abc'), { recursive: true });
    mkdirSync(join(legacyDir, 'session-def'), { recursive: true });
    mkdirSync(join(legacyDir, 'other'), { recursive: true });

    const dirs = getSessionDirs();
    expect(dirs).toContain(join(legacyDir, 'session-abc'));
    expect(dirs).toContain(join(legacyDir, 'session-def'));
    expect(dirs).not.toContain(join(legacyDir, 'other'));

    rmSync(legacyDir, { recursive: true, force: true });
  });
});
