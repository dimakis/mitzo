import { parseSlashCommand, resolveSlashCommand } from './slash-commands.js';
import type { SkillRegistry } from './skills.js';
import type { EventStore } from './event-store.js';
import { buildSkillRegistry } from './skill-registry-runtime.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import type { AccountBinding } from '@mitzo/protocol';
import type { HostRepositoryReservationInput } from './repository-workspaces.js';
import { assertSkillRuntimeSupport } from './skill-runtime-support.js';

const nativeNames = new Set(['skills', 'models', 'close', 'deliberate', 'fuse']);

function assertSupported(registry: SkillRegistry, name: string, seen = new Set<string>()) {
  if (seen.has(name)) return; // The shared resolver reports circular dependencies.
  seen.add(name);
  const skill = registry.get(name);
  assertSkillRuntimeSupport(skill?.allowedTools);
  for (const dependency of skill?.requiredSkills ?? []) assertSupported(registry, dependency, seen);
}

/** Ordinary commands keep their selected owner; no legacy dispatch or tool-policy fallback. */
export function resolveOrdinarySkillPrompt(text: string, registry: SkillRegistry) {
  const parsed = parseSlashCommand(text);
  if (!parsed || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parsed.name)) return;
  if (nativeNames.has(parsed.name))
    throw Error('Use Chat settings or the corresponding app action for this command.');
  if (!registry.get(parsed.name)) return;
  assertSupported(registry, parsed.name);
  const resolution = resolveSlashCommand(text, registry, nativeNames);
  if (resolution.type === 'error') throw Error(resolution.message);
  if (resolution.type === 'skill') return resolution.renderedPrompt;
}

export function ordinarySkillEntries(registry: SkillRegistry) {
  return registry.listPublic().map((skill) => {
    let unavailableReason: string | undefined;
    try {
      resolveOrdinarySkillPrompt(`/${skill.name}`, registry);
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : 'Skill unavailable';
    }
    return { ...skill, unavailableReason };
  });
}

export async function ordinaryWorkspaceSkillEntries(
  workspaces: Pick<RepositoryWorkspaces, 'get' | 'readPreparedHostSource'>,
  id: string,
  binding: (accountId: string, model: string) => AccountBinding,
) {
  const record = workspaces.get(id);
  return workspaces.readPreparedHostSource(
    id,
    binding(record.binding.accountId, record.binding.model),
    (directory) => ordinarySkillEntries(buildSkillRegistry(directory, true)),
  );
}

/** Resolve before first admission against the qualified retained source, not a future cwd. */
export async function prepareOrdinarySkillCommand(
  workspaces: Pick<RepositoryWorkspaces, 'readReservedHostSource'>,
  reservation: Omit<HostRepositoryReservationInput, 'signal'>,
  command: { store: EventStore; id: string; text: string; signal: AbortSignal },
) {
  const { store, id, text, signal } = command;
  if (store.getSendCommand(id) || store.getOrdinarySkillContext(reservation.conversationId, id))
    return;
  if (!parseSlashCommand(text)) return;
  return workspaces.readReservedHostSource(
    reservation,
    (directory) => ({
      text,
      prompt: resolveOrdinarySkillPrompt(text, buildSkillRegistry(directory, true)) ?? text,
    }),
    signal,
  );
}

/** Run under the owned admission fence; commit the decision with the command. */
export function freezeOrdinarySkillCommand(
  store: EventStore,
  meta: { sessionId: string; cwd?: string | null },
  commandId: string,
  payload: Record<string, unknown>,
  admit: () => void,
  prepared?: { text: string; prompt: string },
) {
  if (!meta.cwd || typeof payload.text !== 'string' || !parseSlashCommand(payload.text))
    return admit();
  if (prepared && prepared.text !== payload.text) throw Error('Skill command changed');
  const context = store.getOrdinarySkillContext(meta.sessionId, commandId);
  const retained = context || store.getSendCommand(commandId);
  const prompt =
    !retained && prepared
      ? prepared.prompt
      : resolveCapturedSkillPrompt(
          store,
          meta.sessionId,
          commandId,
          payload.text,
          buildSkillRegistry(meta.cwd),
        );
  store.admitWithOrdinarySkillContext(
    meta.sessionId,
    commandId,
    context ?? { text: payload.text, prompt },
    admit,
  );
}

/** Freeze resolved instructions alongside the original command for queue/restart recovery.
 * Called only by the admitted runtime's prompt assembly, in its own host workspace.
 */
export function captureOrdinarySkillPrompt(
  store: EventStore,
  sessionId: string,
  commandId: string,
  text: string,
  registry: SkillRegistry,
) {
  if (!parseSlashCommand(text)) return text;
  const prompt = resolveCapturedSkillPrompt(store, sessionId, commandId, text, registry);
  if (!store.getOrdinarySkillContext(sessionId, commandId))
    store.append(sessionId, 'ordinary_skill_context', { messageId: commandId, text, prompt });
  return prompt;
}

function resolveCapturedSkillPrompt(
  store: EventStore,
  sessionId: string,
  commandId: string,
  text: string,
  registry: SkillRegistry,
) {
  const context = store.getOrdinarySkillContext(sessionId, commandId);
  if (context) {
    if (context.text !== text) throw Error('Skill command changed');
    return context.prompt;
  }
  const existing = store.getSendCommand(commandId);
  if (existing && (existing.sessionId !== sessionId || existing.payload.text !== text))
    throw Error('Skill command changed');
  // A saved command without this feature's record predates capture. Preserve its
  // original passthrough rather than resolving it against today's catalogue.
  return existing ? text : (resolveOrdinarySkillPrompt(text, registry) ?? text);
}
