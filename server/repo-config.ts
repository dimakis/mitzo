import { readFileSync } from 'fs';
import { join } from 'path';

export interface QuickAction {
  label: string;
  desc: string;
  path?: string;
  prompt?: string;
  cwd?: string;
  extraTools?: string;
}

export interface RepoConfig {
  quickActions: QuickAction[];
  venvPaths: string[];
  resolvedVenvPaths: string[];
}

const EMPTY_CONFIG: RepoConfig = {
  quickActions: [],
  venvPaths: [],
  resolvedVenvPaths: [],
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

  return { quickActions, venvPaths, resolvedVenvPaths };
}
