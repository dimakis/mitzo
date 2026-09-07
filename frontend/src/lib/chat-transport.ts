export type ChatTransportPreference = 'sse' | 'ws' | null;

/** Keep WKWebView on the proven WebSocket transport unless SSE is explicitly requested. */
export function shouldUseSseTransport(
  nativePlatform: boolean,
  preference: ChatTransportPreference,
): boolean {
  if (preference === 'sse') return true;
  if (preference === 'ws') return false;
  return !nativePlatform;
}
