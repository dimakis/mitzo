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
let memory: AgentTaskWorkingCopy | null = null;
const retained = new Map<string, AgentTaskWorkingCopy>();
let pendingStorage = false;
const taskKey = (id: string) => `${KEY}:${id}`;
export function loadAgentTaskWorkingCopy(taskId?: string): AgentTaskWorkingCopy | null {
  const fallback = () => (taskId ? (retained.get(taskId) ?? null) : memory);
  if (pendingStorage) return fallback();
  try {
    const parsed = schema.safeParse(
      JSON.parse(sessionStorage.getItem(taskId ? taskKey(taskId) : KEY) ?? 'null'),
    );
    return parsed.success && (!taskId || parsed.data.taskId === taskId) ? parsed.data : null;
  } catch {
    return fallback();
  }
}
export function saveAgentTaskWorkingCopy(copy: AgentTaskWorkingCopy | null): boolean {
  const previous = loadAgentTaskWorkingCopy();
  memory = copy;
  if (copy) retained.set(copy.taskId, copy);
  else if (previous?.dirty) retained.delete(previous.taskId);
  try {
    if (copy) {
      const serialized = JSON.stringify(copy);
      sessionStorage.setItem(taskKey(copy.taskId), serialized);
      sessionStorage.setItem(KEY, serialized);
    } else {
      // Closing a clean editor keeps incomplete device-only choices for that task.
      // Confirmed discard removes its unsaved working copy as well.
      if (previous?.dirty) sessionStorage.removeItem(taskKey(previous.taskId));
      sessionStorage.removeItem(KEY);
    }
    pendingStorage = false;
    return true;
  } catch {
    pendingStorage = true;
    return false;
  }
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
