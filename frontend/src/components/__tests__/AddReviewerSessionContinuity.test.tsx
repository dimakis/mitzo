// @vitest-environment jsdom
import { reviewerOperations } from '../../lib/symposium-reviewer-operations';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponsiveChatView } from '../ResponsiveChatView';
import { apiFetch } from '../../lib/api-fetch';
const session = vi.hoisted(() => ({ id: 'first' }));
vi.mock('@mitzo/client/hooks', () => ({ useMitzoStore: () => session.id }));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('../../pages/DesktopChatView', async () => {
  const { AddAgentSheet } = await import('../AddReviewerSheet');
  return { DesktopChatView: () => <AddAgentSheet sessionId={session.id} /> };
});
vi.mock('../../pages/ChatView', () => ({ ChatView: () => null }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({ onChange }: { onChange(v: unknown): void }) => (
    <button onClick={() => onChange({ accountId: 'a', model: 'luna', reasoningEffort: 'low' })}>
      Choose account
    </button>
  ),
}));
vi.mock('../SymposiumProfilePicker', () => ({ SymposiumProfilePicker: () => null }));
const config = {
  version: 2,
  revision: 1,
  state: 'active',
  anchorSeatId: 'anchor',
  seats: [{ id: 'anchor', accountBinding: { accountId: 'a' } }],
};
const response = (v: unknown) => new Response(JSON.stringify(v));
const status = () => ({
  sessionId: session.id,
  config,
  runtimeAvailable: true,
  seats: [{ seatId: 'anchor', membership: { state: 'active', generation: 1 } }],
  deliveries: [],
});
afterEach(() => {
  vi.useRealTimers();
  reviewerOperations.reset();
  cleanup();
  vi.resetAllMocks();
  session.id = 'first';
});
async function start() {
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Agent name'), {
    target: { value: 'Reviewer continuity' },
  });
  fireEvent.change(screen.getByLabelText('Agent instructions'), {
    target: { value: 'Check only approved changes' },
  });
  fireEvent.change(screen.getByLabelText('Initial message'), {
    target: { value: 'Approved initial message' },
  });
  fireEvent.click(screen.getByText('Choose account'));
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
}
it('stops the old pipeline at the actual ResponsiveChatView session remount after context preparation', async () => {
  let resolve!: (v: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/context-package')
      ? new Promise<Response>((done) => {
          resolve = done;
        })
      : response(status()),
  );
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(resolve).toBeDefined());
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => resolve(response({ content: 'Approved context' })));
  expect(
    vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/seats/revise')),
  ).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/membership'))).toBe(
    false,
  );
});
it('keeps uncertain seat mutation identity and immutable approval across actual keyed session remounts', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/context-package')
      ? response({ content: '' })
      : String(url).endsWith('/seats/revise')
        ? new Promise<Response>((_, fail) => {
            reject = fail;
          })
        : response(status()),
  );
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(reject).toBeDefined());
  const original = vi
    .mocked(apiFetch)
    .mock.calls.find(([url]) => String(url).endsWith('/seats/revise'))!;
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => reject(new Error('Response lost')));
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByLabelText('Agent name')).toHaveValue('Reviewer continuity');
  expect(screen.getByLabelText('Initial message')).toHaveValue('Approved initial message');
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add agent and queue message' }));
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
  ).toHaveLength(1);
  expect(JSON.parse(String(original[1]?.body)).seatId).toMatch(/^agent-/);
});
it('resolves a lost first message only from its exact saved receipt after keyed remount', async () => {
  const localConfig = structuredClone(config);
  let reject!: (error: Error) => void;
  let queued: Record<string, unknown> | undefined;
  let receipt: Record<string, unknown> | undefined;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/context-package')) return response({ content: 'Frozen full context' });
    if (path.endsWith('/status'))
      return response({
        sessionId: 'first',
        config: localConfig,
        runtimeAvailable: true,
        seats: localConfig.seats.map((seat) => ({
          seatId: seat.id,
          membership: { state: 'active', generation: 1 },
        })),
        deliveries: receipt ? [receipt] : [],
      });
    if (path.endsWith('/seats/revise')) {
      const body = JSON.parse(String(init?.body));
      localConfig.revision++;
      localConfig.seats.push({
        ...body,
        id: body.seatId,
        accountBinding: { accountId: body.accountId, model: body.model, bindingRevision: 7 },
      });
      return response(localConfig);
    }
    if (path.endsWith('/deliveries')) {
      queued = JSON.parse(String(init?.body));
      return new Promise<Response>((_, fail) => {
        reject = fail;
      });
    }
    return response({});
  });
  const view = render(<ResponsiveChatView />);
  await start();
  await waitFor(() => expect(reject).toBeDefined());
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  await act(async () => reject(new Error('Queue response lost')));
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  receipt = { ...queued, sessionId: 'first', idempotencyKey: 'different-operation' };
  fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  receipt = { ...queued, sessionId: 'first' };
  fireEvent.click(screen.getByRole('button', { name: 'Check saved operation' }));
  await screen.findByText(/Agent added/);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/deliveries')),
  ).toHaveLength(1);
  expect(queued?.originalContent).toContain('Frozen full context');
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/context-package')),
  ).toHaveLength(1);
});
it('releases the pending wait after a bounded timeout while preserving uncertain identity across remount', async () => {
  let started = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/context-package')) return response({ content: '' });
    if (String(url).endsWith('/seats/revise')) {
      started = true;
      vi.useFakeTimers();
      return new Promise<Response>(() => {});
    }
    return response(status());
  });
  const view = render(<ResponsiveChatView />);
  await act(async () => {
    await start();
  });
  expect(started).toBe(true);
  session.id = 'second';
  view.rerender(<ResponsiveChatView />);
  const operation = Object.values(reviewerOperations.snapshot())[0];
  expect(operation.pending).toBe(true);
  expect(operation.uncertain?.path).toMatch(/seats\/revise$/);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  });
  vi.useRealTimers();
  expect(Object.values(reviewerOperations.snapshot())[0].pending).toBe(false);
  expect(Object.values(reviewerOperations.snapshot())[0].uncertain).toEqual(operation.uncertain);
  session.id = 'first';
  view.rerender(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  expect(screen.getByRole('button', { name: 'Add agent and queue message' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check saved operation' })).toBeEnabled();
  expect(Object.values(reviewerOperations.snapshot())[0].key).toBe(operation.key);
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/seats/revise')),
  ).toHaveLength(1);
});
