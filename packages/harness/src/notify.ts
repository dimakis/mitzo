import { NOTIFY_INPUT_MAX_CHARS } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('ntfy');

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_AUTH_TOKEN = process.env.NTFY_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL;

export function isConfigured(): boolean {
  return !!(NTFY_TOPIC && BASE_URL);
}

function sessionUrl(sessionId?: string): string {
  if (!BASE_URL) return '';
  return sessionId ? `${BASE_URL}/chat/${sessionId}` : BASE_URL;
}

function titleHeader(title: string): string {
  // ntfy decodes RFC 2047 headers; fetch accepts only byte-valued header text.
  return /[^\x20-\x7e]/.test(title)
    ? `=?UTF-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`
    : title;
}

export async function sendPermissionNotification(
  toolName: string,
  toolInput: string,
  permId: string,
  sessionId?: string,
  options?: { reviewOnly: boolean },
): Promise<boolean> {
  if (!NTFY_TOPIC || !BASE_URL) return false;

  const truncatedInput =
    toolInput.length > NOTIFY_INPUT_MAX_CHARS
      ? toolInput.slice(0, NOTIFY_INPUT_MAX_CHARS) + '...'
      : toolInput;
  const token = NTFY_AUTH_TOKEN || '';

  const allowUrl = `${BASE_URL}/api/permission/${permId}/respond?decision=once&token=${token}`;
  const denyUrl = `${BASE_URL}/api/permission/${permId}/respond?decision=deny&token=${token}`;

  const headers: Record<string, string> = {
    Title: titleHeader(options?.reviewOnly ? toolName : `Mitzo: ${toolName}`),
    Priority: '4',
    Tags: 'robot',
    Actions: [
      ...(options?.reviewOnly
        ? []
        : [
            `http, Allow, ${allowUrl}, method=POST, clear=true`,
            `http, Deny, ${denyUrl}, method=POST, clear=true`,
          ]),
      `view, Open Mitzo, ${sessionUrl(sessionId)}`,
    ].join('; '),
  };

  try {
    const response = await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: options?.reviewOnly ? truncatedInput : `${toolName}: ${truncatedInput}`,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      log.warn('permission notification rejected', {
        stage: 'notification_delivery',
        code: 'ntfy_http_failure',
        status: response.status,
        permId,
        sessionId,
      });
    return response.ok;
  } catch (err: unknown) {
    log.error('failed to send notification', {
      stage: 'notification_delivery',
      code: 'ntfy_transport_failure',
      permId,
      sessionId,
      error: err instanceof Error ? err.message : err,
    });
    return false;
  }
}

export async function sendTurnCompleteNotification(
  sessionId?: string,
  snippet?: string,
  sessionTitle?: string,
): Promise<void> {
  if (!NTFY_TOPIC || !BASE_URL) return;

  const title = sessionTitle ? `Mitzo: ${sessionTitle}` : 'Mitzo';
  const headers: Record<string, string> = {
    Title: titleHeader(title),
    Priority: '3',
    Tags: 'speech_balloon',
    Actions: `view, Open Mitzo, ${sessionUrl(sessionId)}`,
  };

  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: snippet || 'The agent has finished its turn.',
    });
  } catch (err: unknown) {
    log.error('failed to send turn-complete notification', {
      error: err instanceof Error ? err.message : err,
    });
  }
}
