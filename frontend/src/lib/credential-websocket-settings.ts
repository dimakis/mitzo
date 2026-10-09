import type { ConnectionWebSocketConfig, WebSocketDraft } from '../types/credential-connections';
const homeAssistantAuth = {
  kind: 'json' as const,
  message: '{"type":"auth"}',
  credentialField: 'access_token',
  challenge: { field: 'type', equals: 'auth_required' },
  success: { field: 'type', equals: 'auth_ok' },
};
const customAuth = {
  kind: 'json' as const,
  message: '{"type":"login"}',
  credentialField: 'token',
  success: { field: 'type', equals: 'ready' },
};
export function websocketDraft(config?: ConnectionWebSocketConfig | null): WebSocketDraft {
  return {
    mode: !config
      ? 'disabled'
      : config.authentication.kind === 'headers'
        ? 'headers'
        : JSON.stringify(config.authentication) === JSON.stringify(homeAssistantAuth)
          ? 'home-assistant'
          : 'custom',
    path: config?.path ?? '/ws',
    protocols: config?.protocols?.join(', ') ?? '',
    authentication: JSON.stringify(config?.authentication ?? customAuth, null, 2),
  };
}
export function websocketConfiguration(draft: WebSocketDraft): ConnectionWebSocketConfig | null {
  if (draft.mode === 'disabled') return null;
  let authentication: ConnectionWebSocketConfig['authentication'];
  if (draft.mode === 'headers') authentication = { kind: 'headers' };
  else if (draft.mode === 'home-assistant') authentication = homeAssistantAuth;
  else {
    try {
      authentication = JSON.parse(draft.authentication);
    } catch {
      throw new Error('Enter valid JSON for WebSocket authentication.');
    }
    if (!authentication || authentication.kind !== 'json')
      throw new Error('Use JSON message authentication for the custom exchange.');
  }
  const protocols = draft.protocols
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return { path: draft.path, authentication, ...(protocols.length ? { protocols } : {}) };
}
