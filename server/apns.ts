/**
 * APNs push notification module.
 *
 * Manages device token registration and sends push notifications via
 * Apple Push Notification service. Tokens are persisted to a JSON file
 * in the Mitzo data directory.
 *
 * Required env vars for sending:
 *   APNS_KEY_PATH  — path to .p8 key file
 *   APNS_KEY_ID    — key ID from App Store Connect
 *   APNS_TEAM_ID   — Apple Developer team ID
 *   APNS_BUNDLE_ID — app bundle ID (default: com.mitzo.app)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createLogger } from '@mitzo/harness';

const log = createLogger('apns');

const APNS_KEY_PATH = process.env.APNS_KEY_PATH;
const APNS_KEY_ID = process.env.APNS_KEY_ID;
const APNS_TEAM_ID = process.env.APNS_TEAM_ID;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.mitzo.app';

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
    // Dynamic import to avoid requiring the module when not configured
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apn = require('@parse/node-apn');
    apnProvider = new apn.Provider({
      token: {
        key: APNS_KEY_PATH!,
        keyId: APNS_KEY_ID!,
        teamId: APNS_TEAM_ID!,
      },
      production: true,
    });
    return apnProvider;
  } catch (err: unknown) {
    log.error('failed to initialize APNs provider', {
      error: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/** Send a push notification to all registered devices. */
export async function sendPush(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const provider = getProvider();
  if (!provider || tokens.length === 0) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const apn = require('@parse/node-apn');
    const notification = new apn.Notification();
    notification.alert = { title, body };
    notification.topic = APNS_BUNDLE_ID;
    notification.sound = 'default';
    notification.badge = 1;
    if (data) notification.payload = data;

    const result = await provider.send(notification, tokens);

    // Remove any invalid tokens
    for (const failure of result.failed) {
      if (failure.status === '410' || failure.response?.reason === 'Unregistered') {
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

export async function sendTurnCompleteNotification(
  sessionId?: string,
  snippet?: string,
): Promise<void> {
  await sendPush('Mitzo: Agent replied', snippet || 'The agent has finished its turn.', {
    type: 'turn_complete',
    sessionId,
  });
}

export async function sendPermissionNotification(
  toolName: string,
  toolInput: string,
  permId: string,
  sessionId?: string,
): Promise<void> {
  const truncated = toolInput.length > 100 ? toolInput.slice(0, 100) + '...' : toolInput;
  await sendPush(`Mitzo: ${toolName}`, truncated, {
    type: 'permission_request',
    toolName,
    permId,
    sessionId,
  });
}
