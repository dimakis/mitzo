import { createLogger } from './logger.js';

const log = createLogger('pushover');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

export function isConfigured(): boolean {
  return !!(process.env.PUSHOVER_API_TOKEN && process.env.PUSHOVER_USER_KEY);
}

function sessionUrl(sessionId?: string): string {
  const base = process.env.BASE_URL;
  if (!base) return '';
  return sessionId ? `${base}/chat/${sessionId}` : base;
}

export async function sendPushoverNotification(
  title: string,
  message: string,
  url?: string,
  urlTitle?: string,
): Promise<void> {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;

  const payload: Record<string, string> = {
    token,
    user,
    title,
    message,
  };

  if (url) payload.url = url;
  if (urlTitle) payload.url_title = urlTitle;

  try {
    await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err: unknown) {
    log.error('failed to send pushover notification', {
      error: err instanceof Error ? err.message : err,
    });
  }
}

export async function sendPermissionNotification(
  toolName: string,
  toolInput: string,
  permId: string,
  sessionId?: string,
): Promise<void> {
  const baseUrl = process.env.BASE_URL;
  if (!isConfigured() || !baseUrl) return;

  await sendPushoverNotification(
    `Mitzo: ${toolName}`,
    toolInput,
    sessionUrl(sessionId),
    'Open Mitzo',
  );
}

export async function sendTurnCompleteNotification(
  sessionId?: string,
  snippet?: string,
): Promise<void> {
  if (!isConfigured()) return;

  await sendPushoverNotification(
    'Mitzo: Agent replied',
    snippet || 'The agent has finished its turn.',
    sessionUrl(sessionId),
    'Open Mitzo',
  );
}
