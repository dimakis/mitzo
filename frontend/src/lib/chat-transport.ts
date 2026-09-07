export type ChatTransportPreference = 'sse' | 'ws' | null;

export function parseChatTransportPreference(value: string | null): ChatTransportPreference {
  return value === 'sse' || value === 'ws' ? value : null;
}

/** Keep WKWebView on the proven WebSocket transport unless SSE is explicitly requested. */
export function shouldUseSseTransport(
  nativePlatform: boolean,
  preference: ChatTransportPreference,
): boolean {
  if (preference === 'sse') return true;
  if (preference === 'ws') return false;
  return !nativePlatform;
}
