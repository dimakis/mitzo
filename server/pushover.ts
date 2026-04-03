import { createLogger } from './logger.js';

const log = createLogger('pushover');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';

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
): Promise<void> {
  const baseUrl = process.env.BASE_URL;
  if (!isConfigured() || !baseUrl) return;

  const ntfyToken = process.env.NTFY_AUTH_TOKEN || '';
  const mitzoUrl = `${baseUrl}/api/permission/${permId}/respond?decision=once&token=${ntfyToken}`;

  await sendPushoverNotification(`Mitzo: ${toolName}`, toolInput, mitzoUrl, 'Open Mitzo');
}

export async function sendTurnCompleteNotification(): Promise<void> {
  const baseUrl = process.env.BASE_URL;
  if (!isConfigured() || !baseUrl) return;

  await sendPushoverNotification(
    'Mitzo: Agent replied',
    'The agent has finished its turn.',
    baseUrl,
    'Open Mitzo',
  );
}
