import type { MitzoMode } from './session-registry.js';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

const TOOL_TIERS: Record<string, ToolTier> = {
  Read: 'safe',
  Glob: 'safe',
  Grep: 'safe',
  WebSearch: 'safe',
  WebFetch: 'safe',
  TodoWrite: 'safe',
  Task: 'safe',

  Write: 'standard',
  Edit: 'standard',
  StrReplace: 'standard',
  EditNotebook: 'standard',

  Bash: 'elevated',
  Shell: 'elevated',
};

export function getToolTier(toolName: string): ToolTier {
  if (TOOL_TIERS[toolName]) return TOOL_TIERS[toolName];
  if (toolName.startsWith('mcp__')) return 'unknown';
  return 'unknown';
}

/**
 * Decision matrix:
 *   ask:   safe=allow, everything else denied by SDK plan mode
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
  for (const [tool] of Object.entries(TOOL_TIERS)) {
    if (shouldAutoAllow(tool, mode)) {
      allowed.push(tool);
    }
  }
  return allowed;
}
