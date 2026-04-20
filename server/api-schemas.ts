import { z } from 'zod';

export const LoginBody = z.object({
  passphrase: z.string().min(1),
});

export const FileWriteBody = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const PermissionDecision = z.enum(['once', 'always', 'deny']);

const CalendarEventSchema = z.object({
  id: z.string(),
  type: z.enum(['meeting', 'milestone']),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  attendeeCount: z.number().optional(),
  status: z.string().optional(),
  hangoutLink: z.string().optional(),
  version: z.string().optional(),
  milestone: z.string().optional(),
  label: z.string().optional(),
  daysAway: z.number().optional(),
  ourFeatures: z.number().optional(),
  totalFeatures: z.number().optional(),
});

const SprintSchema = z.object({
  id: z.string(),
  type: z.literal('sprint'),
  title: z.string(),
  start: z.string(),
  end: z.string(),
});

export const CalendarResponse = z.object({
  startDate: z.string(),
  endDate: z.string(),
  events: z.array(CalendarEventSchema),
  sprints: z.array(SprintSchema),
});

// -- Todo schemas --

const TodoSourceSchema = z.object({
  type: z.string(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  snippet: z.string().optional().default(''),
});

const TodoContextHintsSchema = z.object({
  repos: z.array(z.string()).optional().default([]),
  paths: z.array(z.string()).optional().default([]),
  issues: z.array(z.string()).optional().default([]),
  docIds: z.array(z.string()).optional().default([]),
  people: z.array(z.string()).optional().default([]),
  jiraKeys: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
  taskHint: z.string().optional().default(''),
});

const TodoItemSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    summary: z.string(),
    profile: z.string(),
    urgency: z.number(),
    // optional+default(false) so the API accepts items without `starred`.
    // The frontend TodoItem declares starred as required (boolean) — Zod's
    // default coercion guarantees it's always present after parsing.
    starred: z.boolean().optional().default(false),
    status: z.enum(['active', 'acknowledged', 'snoozed', 'completed']),
    ageDays: z.number(),
    parentId: z.string().nullable().optional().default(null),
    children: z.array(TodoItemSchema).optional().default([]),
    childCount: z.number().optional().default(0),
    completedChildCount: z.number().optional().default(0),
    sources: z.array(TodoSourceSchema),
    contextHints: TodoContextHintsSchema,
  }),
);

export const TodoListResponse = z.object({
  profiles: z.array(z.string()),
  items: z.array(TodoItemSchema),
});

export const TodoCreateBody = z.object({
  summary: z.string().min(1).max(500),
  profile: z.string().min(1).max(100),
  parentId: z.string().optional(),
});

export const TodoActionBody = z.object({
  action: z.enum(['ack', 'snooze', 'done', 'star', 'unstar']),
  days: z.number().optional(),
});

export const TodoActionResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

// -- Task schemas --

export const TaskCreateBody = z.object({
  title: z.string().min(1),
  parentId: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  sessionPolicy: z.enum(['reuse', 'spawn', 'auto']).optional(),
  annotations: z.array(z.string()).optional(),
  stageType: z.enum(['agent_work', 'wait_for_signal', 'human_review']).optional(),
  gateConfig: z.record(z.string(), z.unknown()).optional(),
  maxRetries: z.number().min(0).optional(),
  templateId: z.string().optional(),
});

export const TaskUpdateBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z
    .enum(['pending', 'active', 'done', 'pending_review', 'blocked', 'skipped', 'failed'])
    .optional(),
  priority: z.number().optional(),
  sessionPolicy: z.enum(['reuse', 'spawn', 'auto']).optional(),
  annotations: z.array(z.string()).optional(),
  summary: z.string().optional(),
  requiresApproval: z.boolean().optional(),
  stageType: z.enum(['agent_work', 'wait_for_signal', 'human_review']).optional(),
  gateConfig: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
  retryCount: z.number().min(0).optional(),
  maxRetries: z.number().min(0).optional(),
});

export const LoopStartBody = z.object({
  goalId: z.string().min(1),
  specMode: z.boolean().optional(),
});

export const WorkflowInstantiateBody = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1),
  variables: z.record(z.string(), z.string()).default({}),
});

export const TemplateCreateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  stages: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        stage_type: z.enum(['agent_work', 'wait_for_signal', 'human_review']),
        gate_config: z.record(z.string(), z.unknown()).optional(),
        max_retries: z.number().min(0).optional(),
      }),
    )
    .min(1),
  variables: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        default: z.string().optional(),
      }),
    )
    .optional(),
});

export const SignalBody = z.object({
  status: z.enum(['pass', 'fail']),
  artifacts: z.record(z.string(), z.unknown()).optional(),
});
