import { parseSlashCommand, resolveSlashCommand } from './slash-commands.js';
import type { SkillRegistry } from './skills.js';
import type { EventStore } from './event-store.js';

const restriction = 'This skill requires tool restrictions that this runtime cannot enforce.';
const nativeNames = new Set(['skills', 'models', 'close', 'deliberate', 'fuse']);

function assertSupported(registry: SkillRegistry, name: string, seen = new Set<string>()) {
  if (seen.has(name)) return; // The shared resolver reports circular dependencies.
  seen.add(name);
  const skill = registry.get(name);
  if (skill?.allowedTools !== undefined) throw Error(restriction);
  for (const dependency of skill?.requiredSkills ?? []) assertSupported(registry, dependency, seen);
}

/** Ordinary commands keep their selected owner; no legacy dispatch or tool-policy fallback. */
export function resolveOrdinarySkillPrompt(text: string, registry: SkillRegistry) {
  const parsed = parseSlashCommand(text);
  if (!parsed) return;
  if (nativeNames.has(parsed.name))
    throw Error('Use Chat settings or the corresponding app action for this command.');
  assertSupported(registry, parsed.name);
  const resolution = resolveSlashCommand(text, registry, nativeNames);
  if (resolution.type === 'error') throw Error(resolution.message);
  if (resolution.type === 'skill') return resolution.renderedPrompt;
}

export function ordinarySkillEntries(registry: SkillRegistry) {
  return registry.listPublic().map((skill) => {
    let unavailableReason: string | undefined;
    try { resolveOrdinarySkillPrompt(`/${skill.name}`, registry); }
    catch (error) { unavailableReason = error instanceof Error ? error.message : 'Skill unavailable'; }
    return { ...skill, unavailableReason };
  });
}

/** Freeze resolved instructions alongside the original command for queue/restart recovery.
 * Called only by the admitted runtime's prompt assembly, in its own host workspace.
 */
export function captureOrdinarySkillPrompt(
  store: EventStore, sessionId: string, commandId: string, text: string, registry: SkillRegistry,
) {
  if (!parseSlashCommand(text)) return text;
  const contexts = store.getEventsOfType(sessionId, 'ordinary_skill_context')
    .filter((event) => event.payload.messageId === commandId);
  if (contexts.length) {
    const context = contexts[0].payload;
    if (context.text !== text || typeof context.prompt !== 'string' ||
      contexts.some((event) => event.payload.text !== text || event.payload.prompt !== context.prompt))
      throw Error('Skill command changed');
    return context.prompt;
  }
  const prompt = resolveOrdinarySkillPrompt(text, registry);
  if (!prompt) return text;
  store.append(sessionId, 'ordinary_skill_context', { messageId: commandId, text, prompt });
  return prompt;
}
