import { z } from 'zod';
import { SessionTimerCreateSchema, SessionMessageSendSchema } from '@mitzo/protocol';
import {
  taskExecutionSchema,
  taskExecutionDefinition,
  TASK_EXECUTION_INSTRUCTIONS,
} from './task-execution-definitions.js';
const id = z.string().min(1).max(200).regex(/^\S+$/);
export const sessionPromptSchemas = {
  TaskExecution: taskExecutionSchema,
  SchedulePrompt: SessionTimerCreateSchema.extend({ sessionId: id.optional() }),
  SendSessionMessage: SessionMessageSendSchema,
  SessionTimers: z.strictObject({
    operation: z.enum([
      'list',
      'sessions',
      'read',
      'delivery',
      'pause',
      'resume',
      'cancel',
      'run',
      'update',
    ]),
    sessionId: id.optional(),
    timerId: id.optional(),
    deliveryId: id.optional(),
    requestId: z.uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    prompt: z.string().trim().min(1).max(16000).optional(),
    intervalMinutes: z.number().int().min(1).max(10080).optional(),
    maxRuns: z.number().int().min(1).max(1000).nullable().optional(),
  }),
};
export const sessionPromptDefinitions = [
  taskExecutionDefinition,
  {
    name: 'SchedulePrompt',
    description:
      'Schedule a recurring prompt in an existing Mitzo session (defaults to this session). Specify intervalMinutes, optional maxRuns, and a stable requestId. Every timer is visible to the user in Chats → Timers and can be paused or cancelled. Uses the recipient’s existing account, runtime and permissions; this does not grant tool or merge authority.',
  },
  {
    name: 'SessionTimers',
    description:
      'List timers or eligible sessions, read a timer or your own message delivery receipt, or pause/resume/cancel/run/update a timer. For changes supply its fresh expectedRevision and a stable requestId. Run means send one prompt, not complete the task. Never retry uncertain work with a new request ID.',
  },
  {
    name: 'SendSessionMessage',
    description:
      'Send an attributed message to another ordinary Mitzo session through its existing prompt queue. Retain the returned delivery ID and use SessionTimers delivery to check it. Reuse requestId on uncertain retries. Include workId for task callbacks; ask the worker to message this session back when finished. Messages grant no extra permissions.',
  },
].map((definition) => ({
  ...definition,
  input_schema: z.toJSONSchema(
    sessionPromptSchemas[definition.name as keyof typeof sessionPromptSchemas],
  ),
}));
export const SESSION_PROMPT_INSTRUCTIONS =
  TASK_EXECUTION_INSTRUCTIONS +
  '\nUse SchedulePrompt for recurring session check-ins; the user can inspect, pause, edit or cancel them under Chats → Timers. Cancel a timer when its purpose is fulfilled. Use SendSessionMessage for peer handoffs and task callbacks, retaining the original session and work IDs. SessionTimers sessions lists eligible recipients. Reuse request IDs on uncertain delivery; a prompt being accepted does not prove its task is complete.\n';
