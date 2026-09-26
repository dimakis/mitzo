// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const upstreamFetch = vi.fn(() => Promise.reject(new Error('Unexpected network call')));
beforeAll(async () => {
  vi.stubGlobal('fetch', upstreamFetch);
  await import('../network');
});
afterAll(() => {
  expect(upstreamFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('returns an array for the desktop inbox consumer on a fresh preview load', async () => {
  const response = await window.fetch('/api/inbox');
  expect(await response.json()).toEqual([]);
});

it('provides deterministic three-seat and ordinary fallback fixtures', async () => {
  const status = await (await window.fetch('/api/sessions/preview-1/symposium')).json();
  expect(status.seats).toHaveLength(3);
  expect(status.profileBindingEnforced).toBe(true);
  const all = await (
    await window.fetch('/api/sessions/preview-1/symposium/perspectives?kind=all')
  ).json();
  expect(all.items.some((item: { receipt?: string }) => item.receipt === 'received')).toBe(true);
  expect(all.items.some((item: { receipt?: string }) => item.receipt === 'uncertain')).toBe(true);
  expect(all.queued).toHaveLength(1);
  const reviewer = await (
    await window.fetch('/api/sessions/preview-1/symposium/perspectives?kind=seat&seatId=reviewer')
  ).json();
  expect(
    reviewer.items.every(
      (item: { seatId?: string; recipientSeatId?: string }) =>
        item.seatId === 'reviewer' || item.recipientSeatId === 'reviewer',
    ),
  ).toBe(true);
  const ordinary = await (await window.fetch('/api/sessions/preview-2/symposium')).json();
  expect(ordinary.config).toBeNull();
  const proposals = await (
    await window.fetch('/api/symposium/profile-proposals?sessionId=preview-3')
  ).json();
  expect(proposals).toHaveLength(1);
});

it('simulates only explicit device-code start, status, and cancellation', async () => {
  const start = await window.fetch('/api/symposium/personal/login', {
    method: 'POST',
    body: JSON.stringify({ method: 'device-code' }),
  });
  const code = await start.json();
  expect(code).toMatchObject({
    state: 'pending',
    attemptId: 'preview-device',
    userCode: 'DEMO-CODE',
  });
  expect(
    await (
      await window.fetch('/api/symposium/personal/login/status?attemptId=preview-device')
    ).json(),
  ).toMatchObject({ state: 'pending', userCode: 'DEMO-CODE' });
  const cancelled = await window.fetch('/api/symposium/personal/login/cancel', {
    method: 'POST',
    body: JSON.stringify({ attemptId: code.attemptId }),
  });
  expect(await cancelled.json()).toMatchObject({ state: 'cancelled' });
  expect(await (await window.fetch('/api/symposium/personal/login/status')).json()).toMatchObject({
    state: 'cancelled',
  });
});

it.each([
  ['/api/symposium/personal/login', 'POST', '{}'],
  ['/api/symposium/personal/login', 'POST', '{'],
  ['/api/symposium/personal/login', 'POST', JSON.stringify({ callbackTransport: 'local' })],
  ['/api/symposium/personal/login', 'POST', JSON.stringify({ method: 'device-code', extra: true })],
  ['/api/symposium/personal/login', 'GET', undefined],
  ['/api/symposium/personal/login/status', 'POST', '{}'],
  ['/api/symposium/personal/login/cancel', 'GET', undefined],
  ['/api/symposium/personal/login/cancel', 'POST', '{}'],
  ['/api/symposium/personal/login/cancel', 'POST', JSON.stringify({ attemptId: 'other' })],
  ['/api/symposium/personal/login/other', 'POST', JSON.stringify({ method: 'device-code' })],
  ['/api/symposium/personal/login-other', 'GET', undefined],
  ['/api/connections', 'POST', '{}'],
])('denies unsupported preview auth request %s %s %s', async (url, method, body) => {
  const before = await (await window.fetch('/api/symposium/personal/login/status')).json();
  expect((await window.fetch(url, { method, body })).status).toBe(405);
  expect(await (await window.fetch('/api/symposium/personal/login/status')).json()).toEqual(before);
});

it('isolates saved personal fixture revisions and never sends mutations upstream', async () => {
  const url = '/api/symposium/personal/connections';
  const before = await (await window.fetch(url)).json();
  expect(before.connections).toHaveLength(2);
  const selected = before.connections[1];
  const start = await window.fetch('/api/symposium/personal/login', {
    method: 'POST',
    body: JSON.stringify({
      method: 'device-code',
      connectionId: selected.id,
      expectedRevision: selected.revision,
    }),
  });
  expect(await start.json()).toMatchObject({ state: 'pending', connectionId: selected.id });
  expect(
    await (await window.fetch('/api/symposium/personal/login/status?connectionId=other')).json(),
  ).toMatchObject({ state: 'idle' });
  await window.fetch('/api/symposium/personal/login/cancel', {
    method: 'POST',
    body: JSON.stringify({ attemptId: 'preview-device' }),
  });
  await window.fetch(`${url}/${before.connections[0].id}/disconnect`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: before.connections[0].revision }),
  });
  const after = await (await window.fetch(url)).json();
  expect(after.connections[0].state).toBe('disconnected');
  expect(after.connections[1].state).toBe(selected.state);
  expect((await window.fetch(url, { method: 'DELETE' })).status).toBe(405);
});
