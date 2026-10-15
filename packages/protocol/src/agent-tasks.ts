import { z } from 'zod';
import { AgentProfileSelectionSchema, type AgentLibraryVersion } from './agent-library.js';
import {
  SessionRuntimeBindingV1Schema,
  type SessionRuntimeBindingV2,
} from './session-runtime-binding.js';

export const AgentTaskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const reference = z.string().trim().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AgentTaskProfileSchema = AgentProfileSelectionSchema.omit({ kind: true }).extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Reviewed intent is retained verbatim, never a grant or evidence of a supported route.
 * Admission must resolve these references using the existing trusted runtime catalog. */
export const AgentTaskExecutionSchema = z.strictObject({
  account: SessionRuntimeBindingV1Schema.shape.account,
  harness: SessionRuntimeBindingV1Schema.shape.harness.shape.implementation,
  targetId: reference,
  model: reference,
  reasoningEffort: reference.nullable(),
  mode: z.enum(['ask', 'agent', 'auto']),
  authorityRefs: z.array(reference).max(64),
});

function validCron(value: string): boolean {
  const fields = value.split(/\s+/);
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return (
    fields.length === 5 &&
    fields.every((field, index) =>
      field.split(',').every((part) => {
        const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
        if (!match) return false;
        const [min, max] = ranges[index];
        if (match[2] && (+match[2] < 1 || +match[2] > max - min + 1)) return false;
        if (match[1] === '*') return true;
        const [start, end = start] = match[1].split('-').map(Number);
        return start >= min && end <= max && start <= end;
      }),
    )
  );
}
export const AgentTaskScheduleSchema = z.strictObject({
  cron: z
    .string()
    .trim()
    .max(128)
    .refine(validCron, 'Expected a numeric five-field cron expression'),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Expected an IANA timezone'),
  // Activation requires the occurrence and admission fences delivered in later slices.
  state: z.literal('paused'),
});
export const AgentTaskDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  objective: z.string().max(32000),
  profile: AgentTaskProfileSchema,
  execution: AgentTaskExecutionSchema.nullable(),
  workspace: z
    .strictObject({ workspaceId: reference, sourceRefs: z.array(reference).max(64) })
    .nullable(),
  schedule: AgentTaskScheduleSchema.nullable(),
  notificationPolicy: z.enum(['results', 'failures', 'none']),
  outputPolicy: z.literal('session'),
});
export const SaveAgentTaskSchema = z.strictObject({
  taskId: AgentTaskIdSchema,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  idempotencyKey: reference,
  definition: AgentTaskDefinitionSchema,
});
export const RemoveAgentTaskSchema = SaveAgentTaskSchema.omit({ definition: true });
export const AgentTaskRecordSchema = z.strictObject({
  taskId: AgentTaskIdSchema,
  revision,
  definition: AgentTaskDefinitionSchema,
  configuration: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('draft') }),
    z.strictObject({ state: z.literal('blocked'), reason: z.literal('admission-unavailable') }),
  ]),
  deleted: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentTaskDefinition = z.infer<typeof AgentTaskDefinitionSchema>;
export type AgentTaskRecord = z.infer<typeof AgentTaskRecordSchema>;

/** Future admission records reference retained immutable task revisions. No run
 * or occurrence is created by task CRUD. These contracts grant no authority. */
export interface AgentTaskOccurrence {
  occurrenceId: string;
  taskId: string;
  scheduleGeneration: number;
  calendarIdentity: string;
  dueAt: string;
  state: 'pending' | 'admitted' | 'missed' | 'overlap-skipped' | 'invalidated' | 'uncertain';
  runId?: string;
}
export interface AgentTaskRun {
  runId: string;
  task: AgentTaskRecord;
  profile: AgentLibraryVersion;
  trigger:
    | { kind: 'manual'; requestId: string; inputHash: string }
    | { kind: 'scheduled'; occurrenceId: string };
  state:
    | 'admitting'
    | 'running'
    | 'waiting-for-user'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'uncertain';
  runtime?: SessionRuntimeBindingV2;
  sessionId?: string;
  receiptRefs: string[];
  outputRefs: string[];
}
