import { createLogger } from './logger.js';

const log = createLogger('pushover');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_MESSAGE_LIMIT = 1024;

export function isConfigured(): boolean {
  return !!(process.env.PUSHOVER_API_TOKEN && process.env.PUSHOVER_USER_KEY);
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
    message: message.length > PUSHOVER_MESSAGE_LIMIT
      ? message.slice(0, PUSHOVER_MESSAGE_LIMIT - 3) + '...'
      : message,
  };

  if (url) payload.url = url;
  if (urlTitle) payload.url_title = urlTitle;

  try {
    const response = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      log.error('pushover API returned error', {
        status: response.status,
        statusText: response.statusText,
      });
    }
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
): Promise<void> {
  const baseUrl = process.env.BASE_URL;
  if (!isConfigured() || !baseUrl) return;

  // Build the Mitzo URL without embedding sensitive tokens — the receiving
  // endpoint authenticates via its own session/cookie, not a query param.
  const mitzoUrl = `${baseUrl}/api/permission/${permId}/respond?decision=once`;

  await sendPushoverNotification(`Mitzo: ${toolName}`, toolInput, mitzoUrl, 'Open Mitzo');
}
