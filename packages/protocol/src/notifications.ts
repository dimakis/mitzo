import { z } from 'zod';
import type { PermissionRequest } from './index.js';

export const NotificationKind = z.enum(['approval', 'question', 'session', 'update', 'test']);
export const NotificationFilter = z.enum([
  'all',
  'needs',
  'sessions',
  'updates',
  'history',
  'archived',
]);
export type NotificationFilter = z.infer<typeof NotificationFilter>;
export type NotificationResolution = 'allowed' | 'denied' | 'expired';
export interface MitzoNotification {
  id: string;
  kind: z.infer<typeof NotificationKind>;
  title: string;
  body: string;
  sessionId?: string;
  permId?: string;
  request?: PermissionRequest;
  inboxFilename?: string;
  createdAt: number;
  expiresAt?: number;
  readAt: number | null;
  resolution: NotificationResolution | null;
  resolvedAt: number | null;
  archivedAt?: number | null;
  inbox?: {
    agent: string;
    tags: string[];
    category: 'briefing' | 'proposal' | 'alert' | 'maintenance' | 'report';
    severity: 'info' | 'warning' | 'critical';
    needsAttention: boolean;
    content?: string;
    status: string;
    sourceArchived?: boolean;
    sourceUpdatedAt?: number;
  };
}
export const InboxQuery = z.object({
  view: z.enum(['needs', 'briefings', 'proposals', 'all', 'archive']).default('needs'),
  query: z.string().max(500).default(''),
  source: z.string().max(150).default(''),
  type: z
    .enum(['', 'sessions', 'updates', 'approval', 'question', 'alert', 'maintenance'])
    .default(''),
  status: z.enum(['', 'unread', 'resolved']).default(''),
  age: z.enum(['any', 'today', 'week', 'month']).default('any'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export type InboxQuery = z.infer<typeof InboxQuery>;
export interface InboxFeed {
  items: MitzoNotification[];
  needsYou: number;
  total: number;
  sources: string[];
}
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const NotificationPreferences = z
  .object({
    approvals: z.boolean().default(true),
    questions: z.boolean().default(true),
    completion: z.enum(['unattended', 'all', 'off']).default('unattended'),
    updates: z.boolean().default(true),
    sensitivePreviews: z.boolean().default(false),
    quietHours: z.boolean().default(false),
    quietStart: time.default('22:00'),
    quietEnd: time.default('08:00'),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid timezone')
      .default('UTC'),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export interface NotificationFeed {
  items: MitzoNotification[];
  needsYou: number;
  total: number;
  preferences: NotificationPreferences;
  delivery: { configured: boolean; registeredDevices: number };
}
