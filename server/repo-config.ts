import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('repo-config');

export interface QuickAction {
  label: string;
  desc: string;
  path?: string;
  prompt?: string;
  cwd?: string;
  extraTools?: string;
}

export type ToolTierOverride = 'safe' | 'standard' | 'elevated';

export interface FileRoot {
  label: string;
  path: string;
}

export interface RepoConfig {
  quickActions: QuickAction[];
  venvPaths: string[];
  resolvedVenvPaths: string[];
  allowedPaths: string[];
  roots: FileRoot[];
  toolTierOverrides: Record<string, ToolTierOverride>;
  inboxPath: string;
  resolvedInboxPath: string;
  repos: Record<string, string>;
}

const EMPTY_CONFIG: RepoConfig = {
  quickActions: [],
  venvPaths: [],
  resolvedVenvPaths: [],
  allowedPaths: [],
  roots: [],
  toolTierOverrides: {},
  inboxPath: '',
  resolvedInboxPath: '',
  repos: {},
};

function isValidQuickAction(item: unknown): item is QuickAction {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.label === 'string' && typeof obj.desc === 'string';
}

export function loadRepoConfig(repoPath: string): RepoConfig {
  if (!repoPath) return { ...EMPTY_CONFIG };

  let raw: string;
  try {
    raw = readFileSync(join(repoPath, '.mitzo.json'), 'utf-8');
  } catch {
    return { ...EMPTY_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_CONFIG };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...EMPTY_CONFIG };
  }

  const obj = parsed as Record<string, unknown>;

  const quickActions = Array.isArray(obj.quickActions)
    ? (obj.quickActions as unknown[]).filter(isValidQuickAction)
    : [];

  const venvPaths = Array.isArray(obj.venvPaths)
    ? (obj.venvPaths as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  const resolvedVenvPaths = venvPaths.map((p) => join(repoPath, p));

  const allowedPaths = Array.isArray(obj.allowedPaths)
    ? (obj.allowedPaths as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];

  function isValidRoot(item: unknown): item is FileRoot {
    if (!item || typeof item !== 'object') return false;
    const o = item as Record<string, unknown>;
    return typeof o.label === 'string' && typeof o.path === 'string';
  }

  const roots = Array.isArray(obj.roots) ? (obj.roots as unknown[]).filter(isValidRoot) : [];

  const validTiers = new Set(['safe', 'standard', 'elevated']);
  const toolTierOverrides: Record<string, ToolTierOverride> = {};
  if (
    obj.toolTierOverrides &&
    typeof obj.toolTierOverrides === 'object' &&
    !Array.isArray(obj.toolTierOverrides)
  ) {
    for (const [tool, tier] of Object.entries(obj.toolTierOverrides as Record<string, unknown>)) {
      if (typeof tier === 'string' && validTiers.has(tier)) {
        toolTierOverrides[tool] = tier as ToolTierOverride;
      }
    }
  }

  const inboxPath = typeof obj.inboxPath === 'string' ? obj.inboxPath : '';
  const resolvedInboxPath = inboxPath ? join(repoPath, inboxPath) : '';

  const repos: Record<string, string> = {};
  if (obj.repos && typeof obj.repos === 'object' && !Array.isArray(obj.repos)) {
    for (const [name, path] of Object.entries(obj.repos as Record<string, unknown>)) {
      if (typeof path !== 'string') continue;
      if (!existsSync(path)) {
        log.warn(`repos.${name}: path does not exist: ${path}`);
        continue;
      }
      if (!existsSync(join(path, '.git'))) {
        log.warn(`repos.${name}: not a git repository: ${path}`);
        continue;
      }
      repos[name] = path;
    }
  }

  return {
    quickActions,
    venvPaths,
    resolvedVenvPaths,
    allowedPaths,
    roots,
    toolTierOverrides,
    inboxPath,
    resolvedInboxPath,
    repos,
  };
}
