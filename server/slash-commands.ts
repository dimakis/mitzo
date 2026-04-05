import type { SkillRegistry, SkillScope } from './skills.js';

// --- Parsing ---

export interface ParsedSlash {
  name: string;
  arguments: string;
}

/**
 * Parse a potential slash command from user input.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(input: string): ParsedSlash | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (!name) return null;

  return { name, arguments: args };
}

// --- Resolution ---

export type SlashResolution =
  | { type: 'passthrough' }
  | {
      type: 'native';
      name: string;
      arguments: string;
    }
  | {
      type: 'skill';
      name: string;
      arguments: string;
      renderedPrompt: string;
      allowedTools?: string[];
      collisions?: Array<{ scope: SkillScope; description: string }>;
    }
  | {
      type: 'error';
      message: string;
      suggestions: string[];
    };

/**
 * Resolve a user message to a slash command result.
 * This is the single server-authoritative resolution point.
 */
export function resolveSlashCommand(
  input: string,
  skillRegistry: SkillRegistry,
  nativeNames: Set<string>,
): SlashResolution {
  const parsed = parseSlashCommand(input);
  if (!parsed) return { type: 'passthrough' };

  // Native commands take absolute priority
  if (nativeNames.has(parsed.name)) {
    return { type: 'native', name: parsed.name, arguments: parsed.arguments };
  }

  // Look up in skill registry
  const skill = skillRegistry.get(parsed.name);
  if (skill) {
    const body = skillRegistry.getBody(parsed.name);
    if (!body) {
      return {
        type: 'error',
        message: `Skill "${parsed.name}" has no body content.`,
        suggestions: [],
      };
    }

    const renderedPrompt = renderSkillPrompt(body, parsed.arguments, {
      name: skill.name,
      scope: skill.scope,
    });

    return {
      type: 'skill',
      name: skill.name,
      arguments: parsed.arguments,
      renderedPrompt,
      allowedTools: skill.allowedTools,
      collisions: skill.collisions,
    };
  }

  // Unknown — find close matches
  const allNames = [...skillRegistry.list().map((s) => s.name), ...Array.from(nativeNames)];
  const suggestions = findSuggestions(parsed.name, allNames);

  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';

  return {
    type: 'error',
    message: `Unknown command "/${parsed.name}".${hint}`,
    suggestions,
  };
}

// --- Prompt rendering ---

/**
 * Render a skill body with $ARGUMENTS substitution and an envelope.
 */
export function renderSkillPrompt(
  body: string,
  args: string,
  meta: { name: string; scope: string },
): string {
  const substituted = body.replace(/\$ARGUMENTS/g, args);

  return [`[Skill: /${meta.name} | source: ${meta.scope}]`, '', substituted].join('\n');
}

// --- Suggestion matching ---

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

function findSuggestions(input: string, candidates: string[], maxDistance = 3): string[] {
  return candidates
    .map((c) => ({ name: c, dist: levenshtein(input.toLowerCase(), c.toLowerCase()) }))
    .filter((c) => c.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((c) => c.name);
}
