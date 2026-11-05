import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SkillRegistry } from './skills.js';
import type { SkillWatcher } from './skill-watcher.js';

export const BUNDLED_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
export const USER_SKILLS_DIR = join(homedir(), '.mitzo', 'skills');
export const NATIVE_COMMAND_NAMES = new Set(['skills', 'models', 'deliberate', 'fuse']);
const registryCache = new Map<string, SkillRegistry>();
let skillWatcher: SkillWatcher | null = null;
export function setSkillWatcher(watcher: SkillWatcher): void {
  skillWatcher = watcher;
}
export function hasSkillWatcher(): boolean {
  return skillWatcher !== null;
}
export function buildSkillRegistry(cwd?: string): SkillRegistry {
  const key = cwd ?? '';
  const cached = registryCache.get(key);
  if (cached) return cached;
  const repoDir = cwd ? join(cwd, '.mitzo', 'skills') : undefined;
  if (repoDir && skillWatcher) skillWatcher.watchDir(repoDir);
  const registry = new SkillRegistry({
    bundledDir: BUNDLED_SKILLS_DIR,
    userDir: USER_SKILLS_DIR,
    repoDir,
    nativeNames: NATIVE_COMMAND_NAMES,
  });
  registryCache.set(key, registry);
  return registry;
}
export function invalidateSkillRegistries(): void {
  for (const registry of registryCache.values()) registry.invalidate();
  registryCache.clear();
}
