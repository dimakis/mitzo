import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('skills');

export const SKILL_SIZE_LIMIT = 10_240; // 10KB

export type SkillScope = 'native' | 'repo' | 'user' | 'bundled';

export interface SkillMetadata {
  name: string;
  description: string;
  scope: SkillScope;
  allowedTools?: string[];
  collisions?: Array<{ scope: SkillScope; description: string }>;
  /** Absolute path to the SKILL.md file — internal use only */
  filePath: string;
}

interface SkillRegistryOptions {
  bundledDir?: string;
  userDir?: string;
  repoDir?: string;
  nativeNames?: Set<string>;
}

interface ParsedSkill {
  description: string;
  allowedTools?: string[];
  body: string;
  filePath: string;
}

// --- YAML frontmatter parsing (safe, no eval) ---

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---')) return null;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  // Minimal safe YAML parser — handles flat key: value and key:\n  - item lists
  const meta: Record<string, unknown> = {};
  const lines = yamlBlock.split('\n');
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(listMatch[1].trim());
      continue;
    }

    // Flush previous list
    if (currentKey && currentList) {
      meta[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value === '') {
      // Start of a list
      currentKey = key;
      currentList = [];
    } else {
      // Strip quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }
  }

  // Flush final list
  if (currentKey && currentList) {
    meta[currentKey] = currentList;
  }

  return { meta, body };
}

// --- Scope discovery ---

function discoverScope(dir: string): Map<string, ParsedSkill> {
  const skills = new Map<string, ParsedSkill>();

  if (!existsSync(dir)) return skills;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    let stat;
    try {
      stat = statSync(skillDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const filePath = join(skillDir, 'SKILL.md');
    if (!existsSync(filePath)) {
      log.warn(`Skipping ${entry}: no SKILL.md found`);
      continue;
    }

    let fileStat;
    try {
      fileStat = statSync(filePath);
    } catch {
      continue;
    }

    if (fileStat.size > SKILL_SIZE_LIMIT) {
      log.warn(`Skipping ${entry}: SKILL.md exceeds ${SKILL_SIZE_LIMIT} bytes`);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      log.warn(`Skipping ${entry}: could not read SKILL.md`);
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      log.warn(`Skipping ${entry}: no valid frontmatter`);
      continue;
    }

    const { meta, body } = parsed;
    if (typeof meta.description !== 'string' || !meta.description) {
      log.warn(`Skipping ${entry}: missing description in frontmatter`);
      continue;
    }

    const allowedTools = Array.isArray(meta['allowed-tools'])
      ? (meta['allowed-tools'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : undefined;

    skills.set(entry, {
      description: meta.description,
      allowedTools,
      body,
      filePath,
    });
  }

  return skills;
}

// --- Registry ---

export class SkillRegistry {
  private opts: SkillRegistryOptions;
  private cache: SkillMetadata[] | null = null;
  private bodyCache = new Map<string, string>();

  constructor(opts: SkillRegistryOptions) {
    this.opts = opts;
  }

  /** Return merged, deduplicated skill metadata in precedence order. */
  list(): SkillMetadata[] {
    if (this.cache) return this.cache;

    const scopeDirs: Array<{ scope: SkillScope; dir: string }> = [];
    if (this.opts.repoDir) scopeDirs.push({ scope: 'repo', dir: this.opts.repoDir });
    if (this.opts.userDir) scopeDirs.push({ scope: 'user', dir: this.opts.userDir });
    if (this.opts.bundledDir) scopeDirs.push({ scope: 'bundled', dir: this.opts.bundledDir });

    const nativeNames = this.opts.nativeNames ?? new Set<string>();

    // Discover all scopes
    const scopeResults = scopeDirs.map(({ scope, dir }) => ({
      scope,
      skills: discoverScope(dir),
    }));

    // Merge with precedence (first scope wins)
    const winners = new Map<string, SkillMetadata>();
    const collisions = new Map<string, Array<{ scope: SkillScope; description: string }>>();

    for (const { scope, skills } of scopeResults) {
      for (const [name, parsed] of skills) {
        if (nativeNames.has(name)) {
          log.warn(`Skipping skill "${name}" in ${scope}: reserved native command name`);
          continue;
        }

        if (winners.has(name)) {
          // This is a collision — lower precedence
          if (!collisions.has(name)) collisions.set(name, []);
          collisions.get(name)!.push({ scope, description: parsed.description });
        } else {
          winners.set(name, {
            name,
            description: parsed.description,
            scope,
            allowedTools: parsed.allowedTools,
            filePath: parsed.filePath,
          });
          // Store body for lazy loading
          this.bodyCache.set(name, parsed.body);
        }
      }
    }

    // Attach collision metadata to winners
    for (const [name, colls] of collisions) {
      const winner = winners.get(name);
      if (winner) winner.collisions = colls;
    }

    const result = Array.from(winners.values());
    this.cache = result;
    return result;
  }

  /** Load skill body on demand. Returns undefined if skill not found. */
  getBody(name: string): string | undefined {
    // Ensure discovery has run
    this.list();
    return this.bodyCache.get(name);
  }

  /** Find a skill by name. */
  get(name: string): SkillMetadata | undefined {
    return this.list().find((s) => s.name === name);
  }

  /** Clear cached data — forces rediscovery on next list() call. */
  invalidate(): void {
    this.cache = null;
    this.bodyCache.clear();
  }
}
