// APNs push notification module — token registration and delivery via Apple Push Notification service.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { createLogger } from '@mitzo/harness';
import type { NotificationPush } from './notification-center.js';

const require = createRequire(import.meta.url);

const log = createLogger('apns');

const APNS_KEY_PATH = process.env.APNS_KEY_PATH;
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.mitzo.app';
const APNS_PRODUCTION = process.env.APNS_PRODUCTION !== 'false';

let tokens: string[] = [];
let tokenStorePath: string | null = null;

export function isConfigured(): boolean {
  return !!(APNS_KEY_PATH && APNS_KEY_ID && APNS_TEAM_ID);
}

/** Set the file path for persisting device tokens and load any existing tokens. */
export function setTokenStorePath(path: string): void {
  tokenStorePath = path;
  if (existsSync(path)) {
    try {
      tokens = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      tokens = [];
    }
  }
}

function persist(): void {
  if (!tokenStorePath) return;
  try {
    writeFileSync(tokenStorePath, JSON.stringify(tokens));
  } catch (err: unknown) {
    log.error('failed to persist device tokens', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

export function registerToken(token: string): void {
  if (!tokens.includes(token)) {
    tokens.push(token);
    persist();
  }
}

export function removeToken(token: string): void {
  const idx = tokens.indexOf(token);
  if (idx !== -1) {
    tokens.splice(idx, 1);
    persist();
  }
}

export function getTokens(): string[] {
  return [...tokens];
}

let apnProvider: import('@parse/node-apn').Provider | null = null;

function getProvider(): import('@parse/node-apn').Provider | null {
  if (apnProvider) return apnProvider;
  if (!isConfigured()) return null;

  try {
    const apn = require('@parse/node-apn');
    apnProvider = new apn.Provider({
      token: {
        key: APNS_KEY_PATH!,
        keyId: APNS_KEY_ID!,
        teamId: APNS_TEAM_ID!,
      },
      production: APNS_PRODUCTION,
    });
    log.info('APNs provider initialized', { production: APNS_PRODUCTION });
    return apnProvider;
  } catch (err: unknown) {
    log.error('failed to initialize APNs provider', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/** APNs notification category for session updates. Register on the iOS client to enable actions. */
export const APNS_CATEGORY = 'SESSION_UPDATE';

/** Send a push notification to all registered devices. */
export async function sendPush(
  title: string,
  body: string,
  data?: Record<string, unknown>,
  options?: { threadId?: string; category?: string },
): Promise<void> {
  const provider = getProvider();
  if (!provider || tokens.length === 0) return;

  try {
    const apn = require('@parse/node-apn');
    const notification = new apn.Notification();
    notification.alert = { title, body };
    notification.topic = APNS_BUNDLE_ID;
    notification.sound = 'default';
    notification.badge = 0;
    if (data) notification.payload = data;
    if (options?.threadId) notification.threadId = options.threadId;
    if (options?.category) notification.category = options.category;

    const result = await provider.send(notification, tokens);

    // Remove any invalid tokens
    for (const failure of result.failed) {
      if (String(failure.status) === '410' || failure.response?.reason === 'Unregistered') {
        removeToken(failure.device);
        log.info('removed unregistered device token', { device: failure.device });
      }
    }
  } catch (err: unknown) {
    log.error('failed to send push notification', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

export function notificationFields(message: NotificationPush) {
  return {
    alert: { title: message.title, body: message.body },
    badge: message.badge,
    topic: APNS_BUNDLE_ID,
    sound: 'default',
    payload: message.data,
    threadId: message.threadId,
    category: message.category,
  };
}

/** Success means APNs accepted at least one device, not proof of Watch delivery. */
export async function deliverNotification(
  message: NotificationPush,
): Promise<'accepted' | 'failed' | 'unavailable'> {
  const provider = getProvider();
  if (!provider || tokens.length === 0) return 'unavailable';
  try {
    const apn = require('@parse/node-apn');
    const notification = Object.assign(new apn.Notification(), notificationFields(message));
    const result = await provider.send(notification, [...tokens]);
    for (const failure of result.failed) {
      if (String(failure.status) === '410' || failure.response?.reason === 'Unregistered')
        removeToken(failure.device);
    }
    return result.sent.length ? 'accepted' : 'failed';
  } catch (err: unknown) {
    log.warn('notification delivery failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return 'failed';
  }
}

/** Apple requires alert push type for any badge payload, even without a banner. */
export function badgeFields(badge: number) {
  return { topic: APNS_BUNDLE_ID, badge, priority: 10, pushType: 'alert' };
}
export async function sendBadgeUpdate(
  badge: number,
): Promise<'accepted' | 'failed' | 'unavailable'> {
  const provider = getProvider();
  if (!provider || !tokens.length) return 'unavailable';
  try {
    const apn = require('@parse/node-apn');
    const notification = Object.assign(new apn.Notification(), badgeFields(badge));
    const result = await provider.send(notification, [...tokens]);
    for (const failure of result.failed) {
      if (String(failure.status) === '410' || failure.response?.reason === 'Unregistered')
        removeToken(failure.device);
    }
    return result.sent.length > 0 && result.failed.length === 0 ? 'accepted' : 'failed';
  } catch (err: unknown) {
    log.warn('badge update failed', { error: err instanceof Error ? err.message : 'unknown' });
    return 'failed';
  }
}

export async function sendTurnCompleteNotification(
  sessionId?: string,
  snippet?: string,
  sessionTitle?: string,
): Promise<void> {
  const title = sessionTitle ? `Mitzo: ${sessionTitle}` : 'Mitzo';
  await sendPush(
    title,
    snippet || 'The agent has finished its turn.',
    { type: 'turn_complete', sessionId },
    { threadId: sessionId, category: APNS_CATEGORY },
  );
}
