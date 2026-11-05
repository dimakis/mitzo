// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionTimersDialog } from '../SessionTimersDialog';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const timer = {
  id: 'timer',
  sessionId: 'worker',
  prompt: 'Check PR #7',
  intervalMinutes: 10,
  maxRuns: null,
  revision: 1,
  status: 'active',
  createdBy: 'agent',
  sourceSessionId: 'coordinator',
  createdAt: 1000,
  updatedAt: 1000,
  nextRunAt: Date.now() + 600000,
  lastRunAt: null,
  runCount: 0,
  lastError: null,
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.endsWith('/sessions'))
      return Response.json([{ sessionId: 'worker', title: 'PR worker' }]);
    if (init?.method === 'POST')
      return Response.json({
        ...timer,
        status: JSON.parse(String(init.body)).action === 'cancel' ? 'cancelled' : 'active',
      });
    return Response.json([timer]);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it('creates a timer from the composer draft without sending or modifying that draft', async () => {
  render(
    <SessionTimersDialog
      sessionId="worker"
      initialPrompt="Keep this exact draft"
      initiallyCreating
      onClose={() => {}}
    />,
  );
  await screen.findByRole('option', { name: 'PR worker' });
  expect((screen.getByRole('textbox', { name: 'Prompt' }) as HTMLTextAreaElement).value).toBe(
    'Keep this exact draft',
  );
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Every' }), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create timer' }));
  await waitFor(() =>
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([url, init]) => String(url) === '/api/session-timers' && init?.method === 'POST',
        ),
    ).toBe(true),
  );
  const [, init] = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(init?.body))).toMatchObject({
    sessionId: 'worker',
    prompt: 'Keep this exact draft',
    intervalMinutes: 15,
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/chat/'))).toBe(
    false,
  );
});
it('makes agent-created timers inspectable and cancellable through the same controls', async () => {
  render(<SessionTimersDialog onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check PR #7' }));
  expect(screen.getByText(/Created by agent/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause timer' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel timer' }));
  await waitFor(() =>
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([, init]) =>
            init?.method === 'POST' && JSON.parse(String(init.body)).action === 'cancel',
        ),
    ).toBe(true),
  );
});
it('can save a timer when a supported browser omits secure-context randomUUID', async () => {
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) });
  render(
    <SessionTimersDialog
      sessionId="worker"
      initialPrompt="Check PR #7"
      initiallyCreating
      onClose={() => {}}
    />,
  );
  await screen.findByRole('option', { name: 'PR worker' });
  fireEvent.click(screen.getByRole('button', { name: 'Create timer' }));
  await waitFor(() =>
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  const [, init] = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(init?.body)).requestId).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
});
it('shows loading and failed reads with a non-mutating retry', async () => {
  vi.mocked(apiFetch).mockRejectedValue(Error('Offline'));
  render(<SessionTimersDialog onClose={() => {}} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(2));
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});
it('reuses the same request after a lost save response and prevents changing an uncertain save', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method === 'POST') throw Error('Connection lost');
    return original(path, init);
  });
  render(
    <SessionTimersDialog
      sessionId="worker"
      initialPrompt="Check PR #7"
      initiallyCreating
      onClose={() => {}}
    />,
  );
  await screen.findByRole('option', { name: 'PR worker' });
  const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create timer' }));
  create();
  await screen.findByText('Connection lost');
  create();
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(2),
  );
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts[1][1]?.body).toBe(posts[0][1]?.body);
  fireEvent.change(screen.getByRole('textbox', { name: 'Prompt' }), {
    target: { value: 'A different task' },
  });
  create();
  await screen.findByText(/previous save may have succeeded/i);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    2,
  );
});
