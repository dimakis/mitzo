import type { SlashResolution } from './slash-commands.js';

export const SKILL_RESTRICTION_UNAVAILABLE =
  'This skill requires tool restrictions that this runtime cannot enforce.';

/** No current prompt adapter retains a verified ceiling across queued inputs,
 * cold resume and delegated execution. Metadata resolution is not admission. */
export function executableSkillResolution(resolution: SlashResolution): SlashResolution {
  return resolution.type === 'skill' && resolution.allowedTools !== undefined
    ? { type: 'error', message: SKILL_RESTRICTION_UNAVAILABLE, suggestions: [] }
    : resolution;
}

export function assertSkillRuntimeSupport(allowedTools: readonly string[] | undefined): void {
  if (allowedTools !== undefined) throw Error(SKILL_RESTRICTION_UNAVAILABLE);
}
