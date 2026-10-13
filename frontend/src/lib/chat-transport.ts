export type ChatTransportPreference = 'sse' | 'ws' | null;

export function parseChatTransportPreference(value: string | null): ChatTransportPreference {
  return value === 'sse' || value === 'ws' ? value : null;
}

/** SSE + POST is the default on every platform; WS remains an explicit diagnostic override. */
export function shouldUseSseTransport(
  _nativePlatform: boolean,
  preference: ChatTransportPreference,
): boolean {
  return preference !== 'ws';
}
