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

export async function sendPermissionNotification(
  toolName: string,
  toolInput: string,
  permId: string,
  sessionId?: string,
): Promise<void> {
  if (!NTFY_TOPIC || !BASE_URL) return;

  const truncatedInput =
    toolInput.length > NOTIFY_INPUT_MAX_CHARS
      ? toolInput.slice(0, NOTIFY_INPUT_MAX_CHARS) + '...'
      : toolInput;
  const token = NTFY_AUTH_TOKEN || '';

  const allowUrl = `${BASE_URL}/api/permission/${permId}/respond?decision=once&token=${token}`;
  const denyUrl = `${BASE_URL}/api/permission/${permId}/respond?decision=deny&token=${token}`;

  const headers: Record<string, string> = {
    Title: `Mitzo: ${toolName}`,
    Priority: '4',
    Tags: 'robot',
    Actions: [
      `http, Allow, ${allowUrl}, method=POST, clear=true`,
      `http, Deny, ${denyUrl}, method=POST, clear=true`,
      `view, Open Mitzo, ${sessionUrl(sessionId)}`,
    ].join('; '),
  };

  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: `${toolName}: ${truncatedInput}`,
    });
  } catch (err: unknown) {
    log.error('failed to send notification', {
      error: err instanceof Error ? err.message : err,
    });
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
    Title: title,
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
