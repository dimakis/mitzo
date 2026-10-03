// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddAgentSheet } from '../../components/AddReviewerSheet';
import { reviewerOperations } from '../../lib/symposium-reviewer-operations';

const upstreamFetch = vi.fn(() => Promise.reject(new Error('Unexpected real network request')));
beforeEach(async () => {
  vi.resetModules();
  upstreamFetch.mockClear();
  vi.stubGlobal('fetch', upstreamFetch);
  await import('../network');
});
afterEach(() => {
  cleanup();
  reviewerOperations.reset();
  expect(upstreamFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('adds a custom preview agent through the real form and queues exactly one simulated message', async () => {
  render(<AddAgentSheet sessionId="preview-1" />);
  await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Use Preview account · Preview model' }),
  );
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Evidence analyst' } });
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Inspect the supplied evidence.' },
  });
  fireEvent.change(screen.getByLabelText('Initial message'), {
    target: { value: 'Explain the assumptions.' },
  });
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand this agent/ }));
  await userEvent.type(
    screen.getByLabelText(/Cross-account confirmation/),
    'ADD CROSS-ACCOUNT SEAT',
  );
  const add = screen.getByRole('button', { name: 'Add agent and queue message' });
  await waitFor(() => expect(add).toBeEnabled());
  await userEvent.click(add);
  await screen.findByText(
    'Agent added. The selected context is queued. Approve and send it in the conversation.',
  );
  const saved = await (await window.fetch('/api/sessions/preview-1/symposium/status')).json();
  const agent = saved.seats.find(
    (seat: { seat: { name: string } }) => seat.seat.name === 'Evidence analyst',
  );
  expect(agent.membership).toMatchObject({
    sessionId: 'preview-1',
    seatId: agent.seatId,
    configRevision: saved.config.revision,
    generation: 1,
    action: 'admit',
    reason: 'Add agent',
    state: 'active',
    reconciliation: 'confirmed',
  });
  expect(saved.simulated).toBe(true);
  expect(saved.deliveries).toHaveLength(1);
  expect(saved.deliveries[0]).toMatchObject({
    sessionId: 'preview-1',
    recipientSeatIds: [agent.seatId],
    originalContent: 'Agent request:\nExplain the assumptions.',
    status: 'awaiting_intervention',
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('returns and saves the exact simulated membership receipt and replays it without advancing generation', async () => {
  const base = '/api/sessions/preview-1/symposium';
  const post = (suffix: string, body: unknown) =>
    window.fetch(`${base}/${suffix}`, { method: 'POST', body: JSON.stringify(body) });
  const before = await (await window.fetch(`${base}/status`)).json();
  const config = await (
    await post('seats/revise', {
      expectedRevision: before.config.revision,
      seatId: 'receipt-agent',
      name: 'Receipt analyst',
      role: 'agent',
      systemPrompt: 'Inspect sample data.',
      color: '#665599',
      accountId: 'preview',
      model: 'preview-model',
      sharedBoundaryAcknowledged: true,
      crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
    })
  ).json();
  const request = {
    seatId: 'receipt-agent',
    action: 'admit',
    expectedGeneration: 0,
    configRevision: config.revision,
    reason: 'Add agent',
    idempotencyKey: 'preview-receipt-admit',
    sharedBoundaryAcknowledged: true,
    crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
  };
  const record = await (await post('membership', request)).json();
  expect(record).toMatchObject({
    sessionId: 'preview-1',
    seatId: request.seatId,
    action: request.action,
    generation: 1,
    configRevision: request.configRevision,
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
    state: 'active',
    reconciliation: 'confirmed',
    simulated: true,
  });
  expect(await (await post('membership', request)).json()).toEqual(record);
  const saved = await (await window.fetch(`${base}/status`)).json();
  expect(
    saved.seats.find((seat: { seatId: string }) => seat.seatId === request.seatId).membership,
  ).toMatchObject(record);
  const conflict = await post('membership', {
    ...request,
    reason: 'Different request with reused key',
  });
  expect(conflict.ok).toBe(false);
  const suspended = await (
    await post('membership', {
      ...request,
      action: 'suspend',
      expectedGeneration: 1,
      reason: 'Pause simulated agent',
      idempotencyKey: 'preview-receipt-suspend',
    })
  ).json();
  expect(suspended).toMatchObject({ generation: 2, state: 'suspended' });
  expect(await (await post('membership', request)).json()).toEqual(record);
  const reusedHistoricalKey = await post('membership', {
    ...request,
    action: 'restore',
    expectedGeneration: 2,
  });
  expect(reusedHistoricalKey.ok).toBe(false);
  const afterReplay = await (await window.fetch(`${base}/status`)).json();
  expect(
    afterReplay.seats.find((seat: { seatId: string }) => seat.seatId === request.seatId).membership,
  ).toEqual(suspended);
});

it('returns exact simulated configuration commit proof, replays the original key, and rejects conflicting reuse without another revision', async () => {
  const { SymposiumConfigurationOperationReceiptSchema } = await import('@mitzo/protocol');
  const base = '/api/sessions/preview-1/symposium';
  const before = await (await window.fetch(`${base}/status`)).json();
  const request = {
    expectedRevision: before.config.revision,
    idempotencyKey: 'preview-config-receipt',
    seatId: 'configuration-agent',
    name: 'Configuration analyst',
    role: 'agent',
    systemPrompt: 'Inspect synthetic inputs.',
    color: '#665599',
    accountId: 'preview',
    model: 'preview-model',
    sharedBoundaryAcknowledged: true,
    crossAccountConfirmation: 'ADD CROSS-ACCOUNT SEAT',
  };
  const post = (body: unknown) =>
    window.fetch(`${base}/seats/revise`, { method: 'POST', body: JSON.stringify(body) });
  const invalidKey = 'not-portable:key';
  expect((await post({ ...request, idempotencyKey: invalidKey })).ok).toBe(false);
  expect((await (await window.fetch(`${base}/status`)).json()).config).toEqual(before.config);
  expect(
    (await window.fetch(`${base}/configuration-operations/${encodeURIComponent(invalidKey)}`)).ok,
  ).toBe(false);
  const committed = await (await post(request)).json();
  const lookup = await (
    await window.fetch(`${base}/configuration-operations/${request.idempotencyKey}`)
  ).json();
  expect(SymposiumConfigurationOperationReceiptSchema.safeParse(lookup.receipt).success).toBe(true);
  expect(lookup).toMatchObject({
    simulated: true,
    receipt: {
      version: 1,
      actor: 'preview-fixture',
      sessionId: 'preview-1',
      idempotencyKey: request.idempotencyKey,
      action: 'seats/revise',
      expectedRevision: request.expectedRevision,
      request,
      config: committed,
    },
  });
  expect(await (await post(request)).json()).toEqual(committed);
  expect((await post({ ...request, name: 'Different approved request' })).ok).toBe(false);
  expect(
    (await (await window.fetch(`${base}/configuration-operations/missing-key`)).json()).receipt,
  ).toBeNull();
  const after = await (await window.fetch(`${base}/status`)).json();
  expect(after.config).toEqual(committed);
  expect(after.config.revision).toBe(request.expectedRevision + 1);
  expect(
    after.seats.find((seat: { seatId: string }) => seat.seatId === request.seatId).membership,
  ).toBeNull();
});

it('recovers a lost preview configuration response through exact saved proof and explicit Add agent continuation', async () => {
  const simulatedFetch = window.fetch.bind(window);
  const mutations: string[] = [];
  let originalKey: string | undefined;
  let lost = false;
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') mutations.push(path);
    const result = await simulatedFetch(url, init);
    if (path.endsWith('/seats/revise') && !lost) {
      lost = true;
      originalKey = JSON.parse(String(init?.body)).idempotencyKey;
      throw new Error('Simulated lost configuration response');
    }
    return result;
  });
  render(<AddAgentSheet sessionId="preview-1" />);
  await userEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await userEvent.click(
    await screen.findByRole('button', { name: 'Use Preview account · Preview model' }),
  );
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Recovered analyst' } });
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Inspect supplied synthetic evidence.' },
  });
  fireEvent.change(screen.getByLabelText('Initial message'), {
    target: { value: 'Describe the assumptions.' },
  });
  await userEvent.click(screen.getByRole('checkbox', { name: /I understand this agent/ }));
  await userEvent.type(
    screen.getByLabelText(/Cross-account confirmation/),
    'ADD CROSS-ACCOUNT SEAT',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  await screen.findByRole('alert');
  const afterLoss = await (await simulatedFetch('/api/sessions/preview-1/symposium/status')).json();
  expect(
    afterLoss.config.seats.filter((seat: { name: string }) => seat.name === 'Recovered analyst'),
  ).toHaveLength(1);
  expect(afterLoss.deliveries).toHaveLength(0);
  expect(mutations.filter((path) => path.endsWith('/membership'))).toHaveLength(0);
  await userEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
  const continueButton = screen.getByRole('button', { name: 'Add agent and queue message' });
  await waitFor(() => expect(continueButton).toBeEnabled());
  expect(mutations.filter((path) => path.endsWith('/membership'))).toHaveLength(0);
  const receipt = await (
    await simulatedFetch(
      `/api/sessions/preview-1/symposium/configuration-operations/${encodeURIComponent(originalKey!)}`,
    )
  ).json();
  expect(originalKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/);
  expect(originalKey).toMatch(/-revise$/);
  expect(encodeURIComponent(originalKey!)).toBe(originalKey);
  expect(receipt.receipt.idempotencyKey).toBe(originalKey);
  await userEvent.click(continueButton);
  await screen.findByText(
    'Agent added. The selected context is queued. Approve and send it in the conversation.',
  );
  const after = await (await simulatedFetch('/api/sessions/preview-1/symposium/status')).json();
  expect(after.config.revision).toBe(afterLoss.config.revision);
  expect(after.deliveries).toHaveLength(1);
  expect(mutations.filter((path) => path.endsWith('/seats/revise'))).toHaveLength(1);
  expect(mutations.filter((path) => path.endsWith('/membership'))).toHaveLength(1);
});
