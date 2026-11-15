import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../src/event-store.js';

const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it('adds bounded recent public requests beyond a clipped prefix without hydrating tools or other audiences', () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.append('s', 'user_message', { messageId: 'first', text: 'Continue' });
  for (let i = 0; i < 300; i++) store.append('s', 'tool_result', { result: 'PRIVATE tool result' });
  for (let i = 0; i < 12; i++)
    store.append('s', 'user_message', {
      messageId: `late-${i}`,
      text: `Repair calendar issue ${i}`,
    });
  for (let i = 0; i < 10; i++) {
    store.append('s', 'user_message', { text: 'PRIVATE closeout', source: 'closeout' });
    store.append('s', 'user_message', {
      text: 'PRIVATE legacy closeout',
      messageId: 'closeout-' + 'a'.repeat(64),
    });
    store.append('s', 'user_message', { text: 'PRIVATE seat', seatId: 'other' });
  }
  store.append('s', 'user_message', { messageId: 'large', text: 'X'.repeat(40000) });
  store.append('foreign', 'user_message', { text: 'PRIVATE foreign' });
  const prefix = store.getSessionNamingEvents('s');
  expect(prefix).toHaveLength(256);
  const combined = store.getSessionNamingEvents('s', { includeRecentRequests: true });
  expect(
    combined
      .filter((event) => event.payload.text?.toString().startsWith('Repair calendar issue'))
      .map((event) => event.payload.text),
  ).toEqual(Array.from({ length: 8 }, (_, i) => `Repair calendar issue ${i + 4}`));
  expect(combined.length).toBeLessThanOrEqual(264);
  expect(JSON.stringify(combined)).not.toContain('PRIVATE');
  expect(new Set(combined.map((event) => event.seq)).size).toBe(combined.length);
  expect(combined.map((event) => event.seq)).toEqual(
    combined.map((event) => event.seq).toSorted((a, b) => a - b),
  );
});

it('recovers a later request when a large assistant block stops the prefix byte budget', () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.append('s', 'user_message', { text: 'Continue' });
  store.append('s', 'block_delta', { blockType: 'text', delta: 'X'.repeat(40000) });
  store.append('s', 'user_message', { text: 'Fix calendar recovery' });
  expect(store.getSessionNamingEvents('s')).toHaveLength(1);
  expect(
    store
      .getSessionNamingEvents('s', { includeRecentRequests: true })
      .map((event) => event.payload.text),
  ).toEqual(['Continue', 'Fix calendar recovery']);
});

it('caps complete recent request text at 32 KiB in addition to the prefix budget', () => {
  const store = new EventStore(':memory:');
  stores.push(store);
  store.append('s', 'user_message', { text: 'Continue' });
  for (let i = 0; i < 300; i++) store.append('s', 'message_end', {});
  for (let i = 0; i < 8; i++)
    store.append('s', 'user_message', { text: `Repair ${i} ` + 'é'.repeat(5000) });
  const combined = store.getSessionNamingEvents('s', { includeRecentRequests: true });
  const recent = combined.filter((event) => event.seq > 301);
  expect(recent.length).toBeGreaterThan(0);
  expect(
    recent.reduce((bytes, event) => bytes + Buffer.byteLength(String(event.payload.text)), 0),
  ).toBeLessThanOrEqual(32768);
  expect(recent.every((event) => String(event.payload.text).endsWith('é'.repeat(5000)))).toBe(true);
});
