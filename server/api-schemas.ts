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
