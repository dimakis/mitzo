// @vitest-environment jsdom
import { expect, it } from 'vitest';
import '../network';

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
