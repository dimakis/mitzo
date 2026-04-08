import { describe, it, expect } from 'vitest';
import { IncomingWsMessage } from '../ws-schemas.js';

describe('WS message schemas', () => {
  it('accepts valid send message', () => {
    const result = IncomingWsMessage.safeParse({
      type: 'send',
      prompt: 'hello',
      clientMsgId: 'user-1-abc',
      model: 'claude-sonnet-4-6',
      mode: 'agent',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('send');
  });

  it('rejects send without clientMsgId', () => {
    const result = IncomingWsMessage.safeParse({
      type: 'send',
      prompt: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects send with empty prompt', () => {
    const result = IncomingWsMessage.safeParse({ type: 'send', prompt: '' });
    expect(result.success).toBe(false);
  });

  it('rejects send with missing prompt', () => {
    const result = IncomingWsMessage.safeParse({ type: 'send' });
    expect(result.success).toBe(false);
  });

  it('accepts valid reattach message', () => {
    const result = IncomingWsMessage.safeParse({ type: 'reattach', clientId: 'client-123' });
    expect(result.success).toBe(true);
  });

  it('rejects reattach without clientId', () => {
    const result = IncomingWsMessage.safeParse({ type: 'reattach' });
    expect(result.success).toBe(false);
  });

  it('accepts stop message', () => {
    const result = IncomingWsMessage.safeParse({ type: 'stop' });
    expect(result.success).toBe(true);
  });

  it('accepts interrupt message', () => {
    const result = IncomingWsMessage.safeParse({
      type: 'interrupt',
      prompt: 'wait',
      clientMsgId: 'user-2-def',
    });
    expect(result.success).toBe(true);
  });

  it('accepts permission_response', () => {
    const result = IncomingWsMessage.safeParse({
      type: 'permission_response',
      permId: 'p1',
      decision: 'once',
    });
    expect(result.success).toBe(true);
  });

  it('accepts set_mode', () => {
    const result = IncomingWsMessage.safeParse({ type: 'set_mode', mode: 'auto' });
    expect(result.success).toBe(true);
  });

  it('rejects set_mode with invalid mode', () => {
    const result = IncomingWsMessage.safeParse({ type: 'set_mode', mode: 'turbo' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown message type', () => {
    const result = IncomingWsMessage.safeParse({ type: 'hack', payload: 'evil' });
    expect(result.success).toBe(false);
  });

  it('accepts send with images array', () => {
    const result = IncomingWsMessage.safeParse({
      type: 'send',
      prompt: 'look at this',
      clientMsgId: 'user-3-ghi',
      images: [{ data: 'base64data', mediaType: 'image/png' }],
    });
    expect(result.success).toBe(true);
  });
});
