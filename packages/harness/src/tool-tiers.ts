import type { MitzoMode } from '@mitzo/protocol';

export type ToolTier = 'safe' | 'standard' | 'elevated' | 'unknown';

const DEFAULT_TOOL_TIERS: Record<string, ToolTier> = {
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

let activeTiers: Record<string, ToolTier> = { ...DEFAULT_TOOL_TIERS };

export function applyTierOverrides(overrides: Record<string, ToolTier>): void {
  activeTiers = { ...DEFAULT_TOOL_TIERS, ...overrides };
}

export function getToolTier(toolName: string): ToolTier {
  if (activeTiers[toolName]) return activeTiers[toolName];
  // Task board tools are always safe
  if (toolName.startsWith('mcp__task-board__')) return 'safe';
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
  // Elevated tools (Bash, Shell) bypass canUseTool in agent + auto modes.
  // The SDK's canUseTool stream breaks on permission requests; HITL is
  // handled conversationally via the system prompt instead.
  if (tier === 'elevated') return mode === 'agent' || mode === 'auto';
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
