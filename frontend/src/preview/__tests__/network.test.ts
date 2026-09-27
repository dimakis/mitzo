// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const upstreamFetch = vi.fn(() => Promise.reject(new Error('Unexpected network call')));
beforeEach(async () => {
  vi.resetModules();
  upstreamFetch.mockClear();
  vi.stubGlobal('fetch', upstreamFetch);
  await import('../network');
});
afterEach(() => {
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

it('reports idle personal login without enabling preview OAuth', async () => {
  const response = await window.fetch('/api/symposium/personal/login/status');
  const body = await response.json();
  expect(body).toEqual({ state: 'idle' });
  expect(body).not.toHaveProperty('authorizationUrl');
  const mutation = await window.fetch('/api/symposium/personal/login', {
    method: 'POST',
    body: '{}',
  });
  expect(mutation.status).toBe(405);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

it('simulates only explicit device-code start, status, and cancellation', async () => {
  const start = await window.fetch('/api/symposium/personal/login', {
    method: 'POST',
    body: JSON.stringify({ method: 'device-code' }),
  });
  const code = await start.json();
  expect(code).toMatchObject({
    state: 'pending',
    attemptId: expect.stringMatching(/^preview-device-\d+$/),
    userCode: 'DEMO-CODE',
  });
  expect(
    await (
      await window.fetch(`/api/symposium/personal/login/status?attemptId=${code.attemptId}`)
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
  const started = await start.json();
  expect(started).toMatchObject({ state: 'pending', connectionId: selected.id });
  expect(
    await (await window.fetch('/api/symposium/personal/login/status?connectionId=other')).json(),
  ).toMatchObject({ state: 'idle' });
  await window.fetch('/api/symposium/personal/login/cancel', {
    method: 'POST',
    body: JSON.stringify({ attemptId: started.attemptId }),
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

it('simulates only explicit model refresh of the current connected fixture revision', async () => {
  const base = '/api/symposium/personal/connections';
  const { connections } = await (await window.fetch(base)).json();
  const row = connections[0];
  const path = `${base}/${row.id}/models/refresh`;
  expect((await window.fetch(path)).status).toBe(405);
  expect((await window.fetch(path, { method: 'POST', body: '{}' })).status).toBe(405);
  const result = await window.fetch(path, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: row.revision }),
  });
  expect(await result.json()).toMatchObject({
    status: 'complete',
    inference: false,
    modelCount: 1,
  });
  expect(
    (
      await window.fetch(path, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: row.revision }),
      })
    ).status,
  ).toBe(405);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

it('provides reviewer context choices and a saved profile without enabling writes', async () => {
  const profiles = await (await window.fetch('/api/symposium/profiles')).json();
  expect(profiles[0].definition.role).toBe('reviewer');
  const context = await (
    await window.fetch('/api/sessions/preview-1/symposium/context-turns')
  ).json();
  expect(context.turns[0].content).toContain('acceptance');
  const mutation = await window.fetch('/api/sessions/preview-1/symposium/context-package', {
    method: 'POST',
    body: '{}',
  });
  expect(mutation.status).toBe(405);
});

it('provides a model catalog for the dedicated Symposium account picker', async () => {
  const accounts = await (await window.fetch('/api/symposium/accounts')).json();
  expect(Array.isArray(accounts)).toBe(true);
  expect(accounts[0]).toMatchObject({
    id: 'preview',
    label: 'Preview account',
    models: [{ id: 'preview-model', label: 'Preview model' }],
  });
});

it('serves findings, delta and unavailable review panels entirely from preview data', async () => {
  const findings = await (await window.fetch('/api/sessions/preview-1/symposium/reviews')).json();
  expect(findings.available).toBe(true);
  expect(findings.workflows[0]).toMatchObject({ status: 'awaiting_fix' });
  expect(findings.workflows[0].findings[0].status).toBe('open');
  const delta = await (await window.fetch('/api/sessions/preview-3/symposium/reviews')).json();
  expect(delta.workflows[0]).toMatchObject({
    status: 'awaiting_delta_review',
    artifactRevision: 'preview-commit-b34',
  });
  const unavailable = await (
    await window.fetch('/api/sessions/preview-2/symposium/reviews')
  ).json();
  expect(unavailable).toEqual({ available: false, workflows: [] });
  const denied = await window.fetch(
    '/api/sessions/preview-1/symposium/reviews/preview-review/actions',
    { method: 'POST', body: JSON.stringify({ action: 'fix' }) },
  );
  expect(denied.status).toBe(405);
  expect(upstreamFetch).not.toHaveBeenCalled();
});

it('serves scoped saved review decision history without contacting a host', async () => {
  const response = await window.fetch('/api/sessions/preview-3/symposium/reviews/preview-review');
  const detail = await response.json();
  expect(detail.workflow.status).toBe('awaiting_delta_review');
  expect(detail.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'fix_authorized',
        detail: expect.objectContaining({
          reason: 'Keep the selected connection across reconnect',
        }),
      }),
    ]),
  );
  expect(
    (await window.fetch('/api/sessions/preview-2/symposium/reviews/preview-review')).status,
  ).toBe(404);
  expect((await window.fetch('/api/sessions/preview-3/symposium/reviews/unknown')).status).toBe(
    404,
  );
  expect(upstreamFetch).not.toHaveBeenCalled();
});

it('uses a fresh device identity for retry and rejects cancellation of the previous attempt', async () => {
  const begin = async () =>
    (
      await window.fetch('/api/symposium/personal/login', {
        method: 'POST',
        body: JSON.stringify({ method: 'device-code' }),
      })
    ).json();
  const first = await begin();
  await window.fetch('/api/symposium/personal/login/cancel', {
    method: 'POST',
    body: JSON.stringify({ attemptId: first.attemptId }),
  });
  const second = await begin();
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(second).toMatchObject({ state: 'pending', userCode: 'DEMO-CODE' });
  expect(
    (
      await window.fetch('/api/symposium/personal/login/cancel', {
        method: 'POST',
        body: JSON.stringify({ attemptId: first.attemptId }),
      })
    ).status,
  ).toBe(405);
  expect(
    await (
      await window.fetch(`/api/symposium/personal/login/status?attemptId=${second.attemptId}`)
    ).json(),
  ).toMatchObject(second);
  expect(
    await (
      await window.fetch(`/api/symposium/personal/login/status?attemptId=${first.attemptId}`)
    ).json(),
  ).toMatchObject({ state: 'unknown' });
  expect(upstreamFetch).not.toHaveBeenCalled();
});
