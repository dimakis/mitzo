import { randomUUID } from 'node:crypto';
import type {
  MitzoNotification,
  NotificationPreferences,
  PermissionRequest,
} from '@mitzo/protocol';
import { hasPending, onPermissionLifecycle } from './permissions.js';
import { NotificationStore } from './notification-store.js';
import { createLogger } from './logger.js';
const log = createLogger('notifications');
// Allow an overnight quiet-hours delay, but never replay old completion banners.
const COMPLETION_PUSH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TEST_PUSH_MAX_AGE_MS = 5 * 60 * 1000;
export interface NotificationPush {
  title: string;
  body: string;
  data: Record<string, unknown>;
  badge: number;
  category: string;
  threadId?: string;
  deliveredDevices?: string[];
}
export interface NotificationDeliveryResult {
  status: 'accepted' | 'failed' | 'unavailable';
  acceptedDevices: string[];
}
interface Dependencies {
  push: (message: NotificationPush) => Promise<NotificationDeliveryResult>;
  changed: () => void;
  configured: () => boolean;
  devices: () => number;
  badge?: (count: number) => Promise<'accepted' | 'failed' | 'unavailable'>;
  sessionTitle: (id: string) => string | undefined;
}
/** Find the next local minute outside quiet hours, including DST transitions. */
export function nextDeliveryAt(prefs: NotificationPreferences, now: number): number | null {
  if (!prefs.quietHours) return now;
  if (prefs.quietStart === prefs.quietEnd) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: prefs.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const quiet = (at: number) => {
    const t = formatter.format(new Date(at));
    return prefs.quietStart < prefs.quietEnd
      ? t >= prefs.quietStart && t < prefs.quietEnd
      : t >= prefs.quietStart || t < prefs.quietEnd;
  };
  if (!quiet(now)) return now;
  const minute = Math.floor(now / 60000) * 60000;
  for (let i = 1; i <= 26 * 60; i++) if (!quiet(minute + i * 60000)) return minute + i * 60000;
  return null;
}
export class NotificationCenter {
  private unsubscribe: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private lastBadge = -1;
  private badgeQueue = Promise.resolve();
  private badgeRetryAt?: number;
  constructor(
    public readonly store: NotificationStore,
    private deps: Dependencies,
  ) {
    store.reconcilePermissions(hasPending);
    this.unsubscribe = onPermissionLifecycle((event) => {
      if (event.type === 'requested') this.permission(event.request);
      else {
        store.resolvePermission(event.permId, event.resolution);
        this.changed();
      }
    });
  }
  changed(): void {
    this.deps.changed();
    const count = this.store.feed('needs').needsYou;
    if (count !== this.lastBadge) {
      void this.queueBadge(count);
    }
  }
  /** Registration must resync even when the count was already cached without devices. */
  syncBadge(): Promise<void> {
    return this.queueBadge(this.store.feed('needs').needsYou);
  }
  private queueBadge(count: number): Promise<void> {
    this.lastBadge = count;
    this.badgeQueue = this.badgeQueue.then(async () => {
      try {
        const status = await this.deps.badge?.(count);
        this.badgeRetryAt =
          !this.deps.badge || status === 'accepted' ? undefined : Date.now() + 60000;
      } catch {
        this.badgeRetryAt = Date.now() + 60000;
      }
    });
    return this.badgeQueue;
  }
  start(): void {
    this.timer ??= setInterval(() => {
      void this.flush().catch((err) =>
        log.warn('notification flush failed', { error: String(err) }),
      );
    }, 1000);
    this.timer.unref();
    this.changed();
  }
  close(): void {
    clearInterval(this.timer);
    this.unsubscribe();
  }
  private publish(input: Parameters<NotificationStore['record']>[0], notify = true): void {
    if (!this.store.record(input)) return;
    if (notify) this.store.queue(input.id, Date.now());
    this.changed();
  }
  private permission(request: PermissionRequest): void {
    if (!request.sessionId) return;
    const title = this.deps.sessionTitle(request.sessionId);
    this.publish({
      id: `permission:${request.permId}`,
      kind: request.questions ? 'question' : 'approval',
      title: request.questions
        ? 'A session has a question'
        : request.title || request.displayName || `Allow ${request.toolName}?`,
      body: title || 'Session needs your attention',
      sessionId: request.sessionId,
      permId: request.permId,
      expiresAt: request.expiresAt,
      request,
    });
  }
  turnComplete(
    sessionId: string,
    seq: number,
    snippet: string,
    title: string | undefined,
    unattended: boolean,
  ): void {
    const prefs = this.store.preferences();
    this.publish(
      {
        id: `turn:${sessionId}:${seq}`,
        kind: 'session',
        title: title || 'Session update',
        body: snippet || 'The agent finished its turn.',
        sessionId,
      },
      prefs.completion === 'all' || (prefs.completion === 'unattended' && unattended),
    );
  }
  update(id: string, title: string, body: string, inboxFilename: string): void {
    this.publish({ id: `inbox:${id}`, kind: 'update', title, body, inboxFilename }, false);
  }
  test(): string {
    const id = `test:${randomUUID()}`;
    this.publish({
      id,
      kind: 'test',
      title: 'Mitzo test notification',
      body: 'Your notification connection is working.',
    });
    return id;
  }
  feed(filter: Parameters<NotificationStore['feed']>[0], limit?: number, offset?: number) {
    if (this.store.reconcilePermissions(hasPending)) this.changed();
    return {
      ...this.store.feed(filter, Date.now(), limit, offset),
      preferences: this.store.preferences(),
      delivery: { configured: this.deps.configured(), registeredDevices: this.deps.devices() },
    };
  }
  private enabled(item: MitzoNotification): boolean {
    const prefs = this.store.preferences();
    return item.kind === 'approval'
      ? prefs.approvals
      : item.kind === 'question'
        ? prefs.questions
        : item.kind === 'session'
          ? prefs.completion !== 'off'
          : item.kind === 'update'
            ? prefs.updates
            : true;
  }
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (this.store.reconcilePermissions(hasPending)) this.changed();
      if (
        this.badgeRetryAt !== undefined &&
        this.badgeRetryAt <= Date.now() &&
        this.deps.configured() &&
        this.deps.devices() > 0
      ) {
        this.badgeRetryAt = undefined;
        await this.syncBadge();
      }
      for (const queued of this.store.due()) {
        // An earlier APNs await can allow this batch entry to change underneath us.
        if (this.store.reconcilePermissions(hasPending)) this.changed();
        const item = this.store.get(queued.id);
        if (!item || item.resolvedAt !== null) continue;
        const age = Date.now() - item.createdAt;
        const stale =
          (item.kind === 'session' && age >= COMPLETION_PUSH_MAX_AGE_MS) ||
          (item.kind === 'test' && age >= TEST_PUSH_MAX_AGE_MS);
        if (stale || !this.enabled(item) || (item.readAt !== null && !item.permId)) {
          this.store.delivery(item.id, 'cancelled');
          continue;
        }
        const at = nextDeliveryAt(this.store.preferences(), Date.now());
        if (at === null || at > Date.now()) continue;
        if (!this.deps.configured() || this.deps.devices() === 0) continue;
        const prefs = this.store.preferences();
        const result = await this.deps.push({
          title:
            prefs.sensitivePreviews || item.kind === 'test'
              ? `Mitzo: ${item.title}`
              : item.kind === 'approval'
                ? 'Mitzo needs your approval'
                : item.kind === 'question'
                  ? 'Mitzo has a question'
                  : 'Mitzo update',
          body:
            prefs.sensitivePreviews || item.kind === 'test'
              ? item.body
              : 'Open Mitzo to review this notification.',
          badge: this.store.feed('needs').needsYou,
          data: { notificationId: item.id, type: item.kind, sessionId: item.sessionId },
          category: item.permId
            ? 'SESSION_PERMISSION'
            : item.kind === 'session'
              ? 'SESSION_UPDATE'
              : 'NOTIFICATION_UPDATE',
          threadId: item.sessionId,
          deliveredDevices: this.store.deliveredDevices(item.id),
        });
        const { status } = result;
        if (status === 'unavailable') continue;
        this.store.delivery(
          item.id,
          status,
          status === 'failed' && this.store.attempts(item.id) < 2 ? Date.now() + 60000 : undefined,
          result.acceptedDevices,
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
let current: NotificationCenter | undefined;
export function setNotificationCenter(center: NotificationCenter): void {
  current = center;
}
export function recordTurnNotification(
  sessionId: string,
  seq: number,
  snippet: string,
  title: string | undefined,
  unattended: boolean,
): void {
  try {
    current?.turnComplete(sessionId, seq, snippet, title, unattended);
  } catch (err) {
    log.warn('could not record notification', { error: String(err) });
  }
}
