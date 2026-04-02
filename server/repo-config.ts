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

export type ToolTierOverride = 'safe' | 'standard' | 'elevated';

export interface RepoConfig {
  quickActions: QuickAction[];
  venvPaths: string[];
  resolvedVenvPaths: string[];
  allowedPaths: string[];
  toolTierOverrides: Record<string, ToolTierOverride>;
}

const EMPTY_CONFIG: RepoConfig = {
  quickActions: [],
  venvPaths: [],
  resolvedVenvPaths: [],
  allowedPaths: [],
  toolTierOverrides: {},
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

  return { quickActions, venvPaths, resolvedVenvPaths, allowedPaths, toolTierOverrides };
}
