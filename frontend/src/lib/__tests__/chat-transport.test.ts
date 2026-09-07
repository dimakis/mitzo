import { describe, expect, it } from 'vitest';
import { parseChatTransportPreference, shouldUseSseTransport } from '../chat-transport';

describe('shouldUseSseTransport', () => {
  it('defaults browsers to SSE', () => {
    expect(shouldUseSseTransport(false, null)).toBe(true);
  });

  it('defaults native WKWebView to WebSocket', () => {
    expect(shouldUseSseTransport(true, null)).toBe(false);
  });

  it('honours explicit diagnostic overrides', () => {
    expect(shouldUseSseTransport(true, 'sse')).toBe(true);
    expect(shouldUseSseTransport(false, 'ws')).toBe(false);
  });

  it('rejects unknown persisted transport values', () => {
    expect(parseChatTransportPreference('unknown')).toBeNull();
    expect(parseChatTransportPreference('sse')).toBe('sse');
    expect(parseChatTransportPreference('ws')).toBe('ws');
  });
});
