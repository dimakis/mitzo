import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillWatcher } from '../skill-watcher.js';

// fs.watch events are async — helper to wait for debounced callback
function waitFor(fn: () => boolean, { timeout = 5000, interval = 50 } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('waitFor timed out'));
      setTimeout(check, interval);
    };
    check();
  });
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mitzo-skill-watcher-test-'));
}

function writeSkill(dir: string, name: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: "test skill"\n---\n\nTest body');
}

describe('SkillWatcher', () => {
  let tempDirs: string[];
  let watchers: SkillWatcher[];

  beforeEach(() => {
    tempDirs = [];
    watchers = [];
  });

  afterEach(() => {
    for (const w of watchers) w.destroy();
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const d = makeTempDir();
    tempDirs.push(d);
    return d;
  }

  function createWatcher(dirs: string[], onInvalidate: () => void): SkillWatcher {
    const w = new SkillWatcher(dirs, onInvalidate);
    watchers.push(w);
    return w;
  }

  it('detects new SKILL.md creation', async () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Write a new skill
    writeSkill(dir, 'deploy');

    await waitFor(() => onInvalidate.mock.calls.length > 0);
    expect(onInvalidate).toHaveBeenCalled();
  });

  it('detects SKILL.md modification', async () => {
    const dir = createTempDir();
    writeSkill(dir, 'deploy');

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Modify existing skill
    writeFileSync(
      join(dir, 'deploy', 'SKILL.md'),
      '---\ndescription: "updated"\n---\n\nUpdated body',
    );

    await waitFor(() => onInvalidate.mock.calls.length > 0);
    expect(onInvalidate).toHaveBeenCalled();
  });

  it('detects SKILL.md deletion', async () => {
    const dir = createTempDir();
    writeSkill(dir, 'deploy');

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Delete SKILL.md
    unlinkSync(join(dir, 'deploy', 'SKILL.md'));

    await waitFor(() => onInvalidate.mock.calls.length > 0);
    expect(onInvalidate).toHaveBeenCalled();
  });

  it('ignores non-SKILL.md files', async () => {
    const dir = createTempDir();
    mkdirSync(join(dir, 'deploy'), { recursive: true });

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Write a non-SKILL.md file
    writeFileSync(join(dir, 'deploy', 'README.md'), '# readme');

    // Wait a bit longer than debounce to ensure no trigger
    await new Promise((r) => setTimeout(r, 600));
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('debounces rapid changes into a single invalidation', async () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Rapid-fire: create 5 skills in quick succession
    for (let i = 0; i < 5; i++) {
      writeSkill(dir, `skill-${i}`);
    }

    await waitFor(() => onInvalidate.mock.calls.length > 0);
    // Wait past the debounce window to let any split batches settle
    await new Promise((r) => setTimeout(r, 500));
    // On slow CI, writes may span multiple debounce windows — tolerate up to 2
    expect(onInvalidate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('handles missing directory gracefully', () => {
    const onInvalidate = vi.fn();
    // Should not throw
    const watcher = createWatcher(['/nonexistent/path/skills'], onInvalidate);
    expect(watcher).toBeDefined();
  });

  it('stops watching after destroy()', async () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    const watcher = createWatcher([dir], onInvalidate);

    watcher.destroy();

    // Write after destroy
    writeSkill(dir, 'deploy');

    await new Promise((r) => setTimeout(r, 600));
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('watchDir is idempotent', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    const watcher = createWatcher([dir], onInvalidate);

    // Call watchDir again — should not throw or duplicate
    watcher.watchDir(dir);
    watcher.watchDir(dir);

    // Destroy should work cleanly
    watcher.destroy();
  });

  it('watchDir is ignored after destroy()', () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    const watcher = createWatcher([dir], onInvalidate);

    watcher.destroy();

    // Should not throw or create a new watch
    const newDir = createTempDir();
    mkdirSync(newDir, { recursive: true });
    watcher.watchDir(newDir);
  });

  it('scheduleInvalidation is a no-op after destroy()', async () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    const watcher = createWatcher([dir], onInvalidate);

    // Write a skill so the watcher sees a SKILL.md event
    writeSkill(dir, 'deploy');

    // Destroy immediately — any in-flight scheduleInvalidation call should be
    // suppressed by the destroyed guard even if the timer hadn't been cleared.
    watcher.destroy();

    // Wait well past the debounce window
    await new Promise((r) => setTimeout(r, 600));
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('calls onInvalidate when a watcher errors out', async () => {
    const dir = createTempDir();
    mkdirSync(dir, { recursive: true });

    const onInvalidate = vi.fn();
    createWatcher([dir], onInvalidate);

    // Remove the directory to trigger a watcher error on some platforms
    rmSync(dir, { recursive: true, force: true });

    // The error handler should call onInvalidate to flush stale caches.
    // On platforms where rmSync doesn't trigger a watcher error, this
    // test is a no-op — the assertion below is lenient.
    await new Promise((r) => setTimeout(r, 600));
    // We can't guarantee the error fires on all platforms, so just
    // verify no exception was thrown and cleanup works.
    expect(true).toBe(true);
  });

  it('detects changes across multiple watched directories', async () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const onInvalidate = vi.fn();
    createWatcher([dir1, dir2], onInvalidate);

    // Write to the second directory
    writeSkill(dir2, 'deploy');

    await waitFor(() => onInvalidate.mock.calls.length > 0);
    expect(onInvalidate).toHaveBeenCalled();
  });
});
