import { watch, existsSync } from 'fs';
import type { FSWatcher } from 'fs';
import { createLogger } from './logger.js';
import { SKILL_WATCHER_DEBOUNCE_MS } from './constants.js';

const log = createLogger('skill-watcher');

export class SkillWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onInvalidate: () => void;
  private destroyed = false;

  constructor(dirs: string[], onInvalidate: () => void) {
    this.onInvalidate = onInvalidate;
    for (const dir of dirs) {
      this.watchDir(dir);
    }
  }

  /** Add a directory to the watch set. Idempotent — safe to call repeatedly. */
  watchDir(dir: string): void {
    if (this.destroyed) return;
    if (this.watchers.has(dir)) return;
    if (!existsSync(dir)) {
      log.debug('skipping non-existent skill directory', { dir });
      return;
    }
    try {
      // recursive: true requires Node ≥19.1 on Linux (macOS/Windows: all versions).
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        // Only invalidate for SKILL.md changes. Null filenames (emitted by
        // some platforms for directory operations) are skipped to avoid
        // spurious invalidations — the debounced rediscovery on the next
        // real SKILL.md event will catch anything missed.
        if (!filename || !(filename === 'SKILL.md' || filename.endsWith('/SKILL.md'))) return;
        this.scheduleInvalidation(dir, filename);
      });
      watcher.on('error', (err) => {
        log.warn('skill watcher error — removing watch', {
          dir,
          error: err.message,
        });
        this.unwatchDir(dir);
        // Flush stale caches so the next registry build retries the watch.
        this.onInvalidate();
      });
      this.watchers.set(dir, watcher);
      log.debug('watching skill directory', { dir });
    } catch (err) {
      log.warn('failed to watch skill directory', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private unwatchDir(dir: string): void {
    const watcher = this.watchers.get(dir);
    if (watcher) {
      watcher.close();
      this.watchers.delete(dir);
    }
  }

  private scheduleInvalidation(dir: string, filename: string): void {
    if (this.destroyed) return;
    log.debug('skill file event', { dir, filename });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.debounceTimer = null;
      log.info('skill files changed — invalidating registries');
      this.onInvalidate();
    }, SKILL_WATCHER_DEBOUNCE_MS);
  }

  /** Stop all watchers and clear pending timers. Late watchDir() calls are ignored. */
  destroy(): void {
    this.destroyed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const [dir, watcher] of this.watchers) {
      log.debug('stopped watching skill directory', { dir });
      watcher.close();
    }
    this.watchers.clear();
  }
}
