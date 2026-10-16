import { z } from 'zod';
import {
  AgentTaskDefinitionSchema,
  AgentTaskProfileSchema,
  type AgentLibraryVersion,
  type AgentTaskRecord,
} from '@mitzo/protocol';
import { ChatRuntimeSelectionSchema, createChatRuntimeSelection } from './chat-runtime-selection';

const schema = z.object({
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().uuid(),
  name: z.string(),
  objective: z.string(),
  profile: AgentTaskProfileSchema,
  // Working input may have an account selected before a model is available.
  runtime: ChatRuntimeSelectionSchema.extend({
    account: ChatRuntimeSelectionSchema.shape.account
      .unwrap()
      .extend({ model: z.string() })
      .nullable(),
  }),
  execution: AgentTaskDefinitionSchema.shape.execution,
  mode: z.enum(['ask', 'agent', 'auto']),
  workspaceId: z.string(),
  sourceRefs: z.string(),
  schedule: z.enum(['manual', 'weekday', 'cron']),
  cron: z.string(),
  timezone: z.string(),
  notificationPolicy: AgentTaskDefinitionSchema.shape.notificationPolicy,
  dirty: z.boolean(),
});
export type AgentTaskWorkingCopy = z.infer<typeof schema>;
const KEY = 'mitzo-agent-task-working-copy';
export const AGENT_TASK_SAVED = 'mitzo:agent-task-saved';
export interface AgentTaskSavedEvent {
  record: AgentTaskRecord;
  stored: boolean;
}
let memory: AgentTaskWorkingCopy | null = null;
const retained = new Map<string, AgentTaskWorkingCopy>();
const pendingCopies = new Set<string>();
let pendingStorage = false;
const taskKey = (id: string) => `${KEY}:${id}`;
export function loadAgentTaskWorkingCopy(taskId?: string): AgentTaskWorkingCopy | null {
  const fallback = () => (taskId ? (retained.get(taskId) ?? null) : memory);
  if (taskId ? pendingCopies.has(taskId) : pendingStorage) return fallback();
  try {
    const parsed = schema.safeParse(
      JSON.parse(sessionStorage.getItem(taskId ? taskKey(taskId) : KEY) ?? 'null'),
    );
    return parsed.success && (!taskId || parsed.data.taskId === taskId) ? parsed.data : null;
  } catch {
    return fallback();
  }
}
function retainCopy(copy: AgentTaskWorkingCopy, active: boolean): boolean {
  retained.set(copy.taskId, copy);
  if (active) memory = copy;
  try {
    const serialized = JSON.stringify(copy);
    sessionStorage.setItem(taskKey(copy.taskId), serialized);
    if (active) sessionStorage.setItem(KEY, serialized);
    pendingCopies.delete(copy.taskId);
    if (active) pendingStorage = false;
    return true;
  } catch {
    pendingCopies.add(copy.taskId);
    if (active) pendingStorage = true;
    return false;
  }
}
export function saveAgentTaskWorkingCopy(copy: AgentTaskWorkingCopy | null): boolean {
  if (copy) return retainCopy(copy, true);
  const previous = loadAgentTaskWorkingCopy();
  memory = null;
  if (previous?.dirty) {
    retained.delete(previous.taskId);
    pendingCopies.delete(previous.taskId);
  }
  try {
    if (previous?.dirty) sessionStorage.removeItem(taskKey(previous.taskId));
    sessionStorage.removeItem(KEY);
    pendingStorage = false;
    return true;
  } catch {
    pendingStorage = true;
    return false;
  }
}
/** A receipt advances its original fence without replacing later input or selecting another editor. */
export function acknowledgeAgentTaskSave(
  request: AgentTaskWorkingCopy,
  record: AgentTaskRecord,
): void {
  if (
    record.taskId !== request.taskId ||
    record.revision !== request.expectedRevision + 1 ||
    record.deleted
  )
    throw Error('Task save receipt is invalid. Your input is retained.');
  const active = loadAgentTaskWorkingCopy();
  const current =
    active?.taskId === request.taskId ? active : loadAgentTaskWorkingCopy(request.taskId);
  let stored = true;
  if (current?.expectedRevision === request.expectedRevision) {
    stored = retainCopy(
      {
        ...current,
        expectedRevision: record.revision,
        idempotencyKey: crypto.randomUUID(),
        dirty: current.idempotencyKey === request.idempotencyKey ? false : current.dirty,
      },
      active?.taskId === request.taskId,
    );
  }
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent<AgentTaskSavedEvent>(AGENT_TASK_SAVED, { detail: { record, stored } }),
    );
}
export function createAgentTaskWorkingCopy(profile: AgentLibraryVersion): AgentTaskWorkingCopy {
  return {
    taskId: crypto.randomUUID(),
    expectedRevision: 0,
    idempotencyKey: crypto.randomUUID(),
    name: '',
    objective: '',
    profile: {
      profileId: profile.profileId,
      revision: profile.revision,
      contentHash: profile.contentHash,
    },
    runtime: {
      ...createChatRuntimeSelection(),
      agentProfile: { profileId: profile.profileId, revision: profile.revision },
    },
    execution: null,
    mode: 'agent',
    workspaceId: '',
    sourceRefs: '',
    schedule: 'manual',
    cron: '0 7 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    notificationPolicy: 'results',
    dirty: true,
  };
}
export function editAgentTask(
  task: AgentTaskRecord,
  location: 'local' | 'openshell' = 'openshell',
): AgentTaskWorkingCopy {
  const d = task.definition;
  return {
    taskId: task.taskId,
    expectedRevision: task.revision,
    idempotencyKey: crypto.randomUUID(),
    name: d.name,
    objective: d.objective,
    profile: d.profile,
    execution: d.execution,
    runtime: {
      ...createChatRuntimeSelection(),
      agentProfile: { profileId: d.profile.profileId, revision: d.profile.revision },
      ...(d.execution
        ? {
            account: {
              accountId: d.execution.account.accountId,
              model: d.execution.model,
              reasoningEffort: d.execution.reasoningEffort,
            },
            accountReference: d.execution.account,
            execution: { location, targetId: d.execution.targetId },
          }
        : {}),
    },
    mode: d.execution?.mode ?? 'agent',
    workspaceId: d.workspace?.workspaceId ?? '',
    sourceRefs: d.workspace?.sourceRefs.join('\n') ?? '',
    schedule: !d.schedule ? 'manual' : d.schedule.cron === '0 7 * * 1-5' ? 'weekday' : 'cron',
    cron: d.schedule?.cron ?? '0 7 * * 1-5',
    timezone: d.schedule?.timezone ?? 'UTC',
    notificationPolicy: d.notificationPolicy,
    dirty: false,
  };
}
