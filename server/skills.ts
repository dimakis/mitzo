import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { load, JSON_SCHEMA } from 'js-yaml';

const log = createLogger('skills');

export const SKILL_SIZE_LIMIT = 10_240; // 10KB

export type SkillScope = 'native' | 'repo' | 'user' | 'bundled';

export interface SkillMetadata {
  name: string;
  description: string;
  scope: SkillScope;
  allowedTools?: string[];
  /** Retained invalid metadata must refuse resolution, never become unrestricted. */
  policyError?: string;
  /** Instruction dependencies, resolved with normal scope precedence. Never grant tools. */
  requiredSkills?: string[];
  /** Skill intentionally needs write access (Edit/Write in allowed-tools). */
  mutating?: boolean;
  collisions?: Array<{ scope: SkillScope; description: string }>;
  /** Absolute path to the SKILL.md file — internal use only */
  filePath: string;
}

/** Safe subset of SkillMetadata for API responses — omits server filesystem paths. */
export type PublicSkillMetadata = Omit<SkillMetadata, 'filePath'>;

interface SkillRegistryOptions {
  bundledDir?: string;
  userDir?: string;
  repoDir?: string;
  nativeNames?: Set<string>;
}

interface ParsedSkill {
  description: string;
  allowedTools?: string[];
  policyError?: string;
  requiredSkills?: string[];
  mutating?: boolean;
  body: string;
  filePath: string;
}

// --- YAML frontmatter parsing (safe, no eval) ---

function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
  policyError?: string;
} | null {
  if (!raw.startsWith('---')) return null;
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  let meta: Record<string, unknown>;
  try {
    const parsed = load(yamlBlock, { schema: JSON_SCHEMA });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw Error('Expected a metadata mapping');
    meta = parsed as Record<string, unknown>;
    if (Object.hasOwn(meta, '<<')) throw Error('YAML merge keys are unsupported');
  } catch {
    // Do not skip the selected skill and fall through to a lower-precedence
    // or provider-native definition. Never expose parser source excerpts.
    return {
      meta: { description: 'Invalid skill metadata' },
      body,
      policyError: 'Invalid skill frontmatter; use a YAML mapping with unique keys.',
    };
  }

  const KNOWN_KEYS = new Set([
    'name',
    'description',
    'allowed-tools',
    'requires-skills',
    'mutating',
  ]);
  for (const key of Object.keys(meta)) {
    if (!KNOWN_KEYS.has(key)) {
      log.warn(`Unknown frontmatter key "${key}" — check for typos`);
    }
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
    let policyError = parsed.policyError;
    const description =
      typeof meta.description === 'string' && meta.description.trim()
        ? meta.description
        : 'Invalid skill metadata';
    if (typeof meta.description !== 'string' || !meta.description.trim())
      policyError ??= 'Skill description must be a non-empty string.';
    const tools = meta['allowed-tools'];
    const allowedTools = typeof tools === 'string' ? tools.split(/[\s,]+/).filter(Boolean) : tools;
    const exactNames = (value: unknown, pattern: RegExp): value is string[] =>
      Array.isArray(value) && value.every((name) => typeof name === 'string' && pattern.test(name));
    if (
      Object.hasOwn(meta, 'allowed-tools') &&
      !exactNames(allowedTools, /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/)
    )
      policyError = 'Unsupported allowed-tools; use exact tool names in a string or YAML sequence.';
    const requiredSkills = meta['requires-skills'];
    if (
      Object.hasOwn(meta, 'requires-skills') &&
      !exactNames(requiredSkills, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
    )
      policyError = 'Unsupported requires-skills; use a YAML sequence of skill names.';
    const mutating = meta['mutating'] === true || meta['mutating'] === 'true' ? true : undefined;

    skills.set(entry, {
      description,
      allowedTools: exactNames(allowedTools, /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/)
        ? allowedTools
        : undefined,
      requiredSkills: exactNames(requiredSkills, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
        ? requiredSkills
        : undefined,
      policyError,
      mutating,
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
            policyError: parsed.policyError,
            requiredSkills: parsed.requiredSkills,
            mutating: parsed.mutating,
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

  /** Return skill metadata safe for API responses (no filesystem paths). */
  listPublic(): PublicSkillMetadata[] {
    return this.list().map(({ filePath: _, ...rest }) => rest);
  }

  /** Clear cached data — forces rediscovery on next list() call. */
  invalidate(): void {
    this.cache = null;
    this.bodyCache.clear();
  }
}
