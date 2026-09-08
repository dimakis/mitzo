import type { MitzoMode } from '@mitzo/protocol';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

const DEFAULT_TOOL_TIERS: Record<string, ToolTier> = {
  Read: 'safe',
  Glob: 'safe',
  Grep: 'safe',
  WebSearch: 'safe',
  WebFetch: 'safe',
  'mcp__task-board__TaskStatus': 'safe',

  TodoWrite: 'standard',
  Task: 'unknown',

  Write: 'standard',
  Edit: 'standard',
  StrReplace: 'standard',
  EditNotebook: 'standard',

  Bash: 'elevated',
  Shell: 'elevated',
};

let activeTiers: Record<string, ToolTier> = { ...DEFAULT_TOOL_TIERS };

export function applyTierOverrides(overrides: Record<string, ToolTier>): void {
  activeTiers = { ...DEFAULT_TOOL_TIERS, ...overrides };
}

export function getToolTier(toolName: string): ToolTier {
  if (activeTiers[toolName]) return activeTiers[toolName];
  if (toolName.startsWith('mcp__')) return 'unknown';
  return 'unknown';
}

/**
 * Decision matrix:
 *   ask:   safe=allow, everything else denied by the permission handler
 *   agent: safe=allow, standard=allow, elevated=prompt, unknown=prompt
 *   auto:  safe=allow, standard=allow, elevated=allow,  unknown=prompt
 */
export function shouldAutoAllow(toolName: string, mode: MitzoMode): boolean {
  const tier = getToolTier(toolName);

  if (tier === 'safe') return true;
  if (tier === 'standard') return mode === 'agent' || mode === 'auto';
  if (tier === 'elevated') return mode === 'auto';
  return false;
}

export function getAllowedToolsForMode(mode: MitzoMode): string[] {
  const allowed: string[] = [];
  for (const [tool] of Object.entries(activeTiers)) {
    if (shouldAutoAllow(tool, mode)) {
      allowed.push(tool);
    }
  }
  return allowed;
}
