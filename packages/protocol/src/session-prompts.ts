import { z } from 'zod';

const id = z.string().min(1).max(200).regex(/^\S+$/);
const prompt = z.string().trim().min(1).max(16_000);
const interval = z.number().int().min(1).max(10_080);
const maxRuns = z.number().int().min(1).max(1000).nullable();
export const SessionTimerCreateSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: id,
  prompt,
  intervalMinutes: interval,
  startImmediately: z.boolean().default(false),
  maxRuns: maxRuns.default(null),
});
export const SessionTimerChangeSchema = z.strictObject({
  requestId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  action: z.enum(['pause', 'resume', 'cancel', 'run', 'update']),
  prompt: prompt.optional(),
  intervalMinutes: interval.optional(),
  maxRuns: maxRuns.optional(),
});
export const SessionTimerSchema = z.strictObject({
  id,
  sessionId: id,
  prompt,
  intervalMinutes: interval,
  maxRuns,
  revision: z.number().int().positive(),
  status: z.enum(['active', 'paused', 'cancelled', 'blocked', 'completed']),
  createdBy: z.enum(['user', 'agent']),
  sourceSessionId: id.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export const SessionMessageSendSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: id,
  text: prompt,
  workId: id.optional(),
});
export type SessionTimer = z.infer<typeof SessionTimerSchema>;
export type SessionTimerCreate = z.infer<typeof SessionTimerCreateSchema>;
export type SessionTimerChange = z.infer<typeof SessionTimerChangeSchema>;
export type SessionMessageSend = z.infer<typeof SessionMessageSendSchema>;
