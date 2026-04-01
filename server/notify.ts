const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_AUTH_TOKEN = process.env.NTFY_AUTH_TOKEN;
const BASE_URL = process.env.BASE_URL;

export function isConfigured(): boolean {
  return !!(NTFY_TOPIC && BASE_URL);
}

export async function sendPermissionNotification(
  toolName: string,
  toolInput: string,
  permId: string,
): Promise<void> {
  if (!NTFY_TOPIC || !BASE_URL) return;

  const truncatedInput = toolInput.length > 100 ? toolInput.slice(0, 100) + '...' : toolInput;
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
      `view, Open Mitzo, ${BASE_URL}`,
    ].join('; '),
  };

  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: `${toolName}: ${truncatedInput}`,
    });
  } catch (err) {
    console.error('[ntfy] failed to send notification:', err);
  }
}
