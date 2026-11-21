// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ContextSnapshotInspector } from '../ContextSnapshotInspector';
import { contextSnapshotFixture } from '../../../../tests/support/context-snapshot-fixture';
import { installDialogStub } from './dialog-stub';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../../lib/api-fetch';
import { TokenBar } from '../TokenBar';
import { ConversationContextUsage } from '../ConversationContextUsage';

beforeEach(() => {
  installDialogStub();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reaches the inspector through the existing ring without changing recorded usage', async () => {
  const fetch = respond();
  render(
    <TokenBar
      sessionId="one"
      alwaysVisible
      tokenState={{
        agentContext: 0,
        contextCeiling: 0,
        sessionTotal: 0,
        numTurns: 0,
        turnIndex: 0,
        numCompactions: 0,
        tokenLimits: null,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
  expect(fetch).not.toHaveBeenCalled();
  open();
  await screen.findByText('Snapshot partial');
  expect(document.querySelector('.token-wheel')).toBeTruthy();
  expect(document.querySelector('.token-bar--unknown')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('button', { name: 'Token usage' }).getAttribute('aria-expanded')).toBe(
    'true',
  );
});

it('keeps per-agent recorded usage separate and cancels a nested inspection on revocation', async () => {
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith('/context')
        ? { sessionId: 'one', contextUsage: null }
        : contextSnapshotFixture(),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const view = render(
    <ConversationContextUsage participants={[{ id: 'one', name: 'Architect' }]} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  open();
  await screen.findByText('Snapshot partial');
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    '/api/sessions/one/context',
    '/api/sessions/one/context-snapshot',
  ]);
  view.rerender(
    <ConversationContextUsage
      participants={[{ id: 'one', name: 'Architect', unavailable: true }]}
    />,
  );
  expect(screen.queryByRole('dialog', { name: 'Context snapshot' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Context by agent' })).toBeTruthy();
});
function respond(body: unknown = contextSnapshotFixture()) {
  const fetch = vi.fn(async () => Response.json(body));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Inspect context' }));
  return screen.getByRole('dialog', { name: 'Context snapshot' });
}
it('restores focus to Inspect context rather than an earlier composer control', async () => {
  respond();
  render(
    <>
      <button type="button">Earlier control</button>
      <ContextSnapshotInspector sessionId="one" />
    </>,
  );
  screen.getByRole('button', { name: 'Earlier control' }).focus();
  const trigger = screen.getByRole('button', { name: 'Inspect context' });
  trigger.focus();
  open();
  await screen.findByText('Snapshot partial');
  screen.getByRole('button', { name: 'Close' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(document.activeElement).toBe(trigger);
});
it('opens with only a passive GET and exposes exact numbers, estimates and non-additive semantics', async () => {
  const fetch = respond();
  render(<ContextSnapshotInspector sessionId="one" />);
  expect(fetch).not.toHaveBeenCalled();
  const dialog = open();
  await within(dialog).findByText('12,001 tokens (estimated)');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([
    '/api/sessions/one/context-snapshot',
    expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
  ]);
  expect(within(dialog).getByText('Observation time', { exact: true })).toBeTruthy();
  expect(within(dialog).getByText(/outside the window/)).toBeTruthy();
  expect(within(dialog).getByText('+1 tokens')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Source contributions' }));
  expect(within(dialog).getByText(/overlap · estimated/)).toBeTruthy();
  expect(within(dialog).getByText(/Source opening is unavailable/)).toBeTruthy();
  expect(within(dialog).queryByRole('link')).toBeNull();
});
it.each([
  'available',
  'partial',
  'stale',
  'unavailable',
  'loading',
  'failed',
  'cancelled',
] as const)('renders %s without polling or fallback', async (status) => {
  const data = contextSnapshotFixture();
  data.status = status;
  if (status === 'stale') data.snapshot!.freshness.state = 'stale';
  if (['unavailable', 'loading', 'failed', 'cancelled'].includes(status)) delete data.snapshot;
  const fetch = respond(data);
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText(`Snapshot ${status}`);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  'adapter_not_attached',
  'refresh_unsupported',
  'unsupported_route',
  'authority_expired',
] as const)('retains the explicit %s reason', async (reason) => {
  respond({ version: 1, sessionId: 'one', revision: 0, status: 'unavailable', reason });
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText(`Reason: ${reason}`);
  if (reason === 'authority_expired')
    expect(screen.getByRole('button', { name: 'Refresh summary' })).toHaveProperty(
      'disabled',
      true,
    );
});
it.each([
  (data: ReturnType<typeof contextSnapshotFixture>) => ({ ...data, version: 2 }),
  (data: ReturnType<typeof contextSnapshotFixture>) => ({ ...data, sessionId: 'other' }),
  (data: ReturnType<typeof contextSnapshotFixture>) => {
    data.snapshot!.usedTokens = -1;
    return data;
  },
  (data: ReturnType<typeof contextSnapshotFixture>) => {
    data.snapshot!.identity.scope = 'subagent';
    data.snapshot!.identity.parentSessionId = 'parent';
    return data;
  },
  (data: ReturnType<typeof contextSnapshotFixture>) => {
    data.snapshot!.binding.model = 'wrong-model';
    data.snapshot!.capacity.modelLimits = { model: 'expected', source: 'runtime', stale: false };
    return data;
  },
])('rejects malformed, versioned and mismatched evidence', async (change) => {
  respond(change(contextSnapshotFixture()));
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByRole('alert');
  expect(screen.queryByText('12,001 tokens (estimated)')).toBeNull();
});
it('accepts additive fields without exposing them', async () => {
  respond({ ...contextSnapshotFixture(), future: 'private-future-value' });
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText('12,001 tokens (estimated)');
  expect(screen.queryByText('private-future-value')).toBeNull();
});
it('requires a separate full-detail consent and sends the exact intent and UUID once', async () => {
  const fetch = respond();
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText('Snapshot partial');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  let request = (fetch.mock.calls as unknown as [string, RequestInit][])[1][1];
  expect(new Headers(request.headers).get('X-Mitzo-Context-Intent')).toBe('refresh-summary');
  expect(JSON.parse(request.body as string)).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    detail: 'summary',
  });
  await screen.findByText('Snapshot partial');
  fireEvent.click(screen.getByRole('button', { name: 'Full detail…' }));
  const full = screen.getByRole('button', { name: 'Refresh full detail' });
  expect(full).toHaveProperty('disabled', true);
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('checkbox', { name: /token-count API calls/ }));
  fireEvent.click(full);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  request = (fetch.mock.calls as unknown as [string, RequestInit][])[2][1];
  expect(new Headers(request.headers).get('X-Mitzo-Context-Intent')).toBe('refresh-full');
  expect(JSON.parse(request.body as string)).toEqual({
    requestId: expect.any(String),
    detail: 'full',
    allowTokenCount: true,
  });
  expect(screen.queryByRole('checkbox')).toBeNull();
});
it('never turns latest-request totals or unknown capacity into occupancy or a percentage', async () => {
  const data = contextSnapshotFixture();
  data.snapshot!.binding.engine = 'codex';
  data.snapshot!.measurement = {
    basis: 'latest-request',
    method: 'codex-event',
    assurance: 'provider-reported',
  };
  delete data.snapshot!.usedTokens;
  data.snapshot!.requestUsage = {
    inputTokens: 100,
    cachedInputTokens: 50,
    outputTokens: 10,
    reasoningOutputTokens: 5,
    totalTokens: 110,
  };
  data.snapshot!.capacity = { kind: 'unknown', source: 'unknown', stale: false };
  data.snapshot!.categories = [];
  data.snapshot!.contributions = [];
  respond(data);
  render(<ContextSnapshotInspector sessionId="one" />);
  const dialog = open();
  await within(dialog).findByText('110 tokens');
  expect(within(dialog).getByText('Occupancy unknown')).toBeTruthy();
  expect(within(dialog).getByText(/already included in input/)).toBeTruthy();
  expect(dialog.textContent).not.toContain('%');
  expect(within(dialog).queryByRole('meter')).toBeNull();
});
it('shows signed disagreement and preserves real zero counts', async () => {
  const data = contextSnapshotFixture();
  data.snapshot!.usedTokens = 0;
  data.snapshot!.reconciliation = { status: 'inconsistent', residualTokens: -12000 };
  respond(data);
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText('0 tokens (estimated)');
  expect(screen.getByText('-12,000 tokens')).toBeTruthy();
  expect(screen.getByText(/inconsistent/)).toBeTruthy();
});
it('fences late A to B responses and aborts on close', async () => {
  let resolveA!: (value: Response) => void;
  const fetch = vi.fn((url: string) =>
    url.includes('/one/')
      ? new Promise<Response>((resolve) => {
          resolveA = resolve;
        })
      : Promise.resolve(Response.json(contextSnapshotFixture('two'))),
  );
  vi.stubGlobal('fetch', fetch);
  const view = render(<ContextSnapshotInspector sessionId="one" />);
  open();
  const signalA = (fetch.mock.calls as unknown as [string, RequestInit][])[0][1].signal!;
  view.rerender(<ContextSnapshotInspector sessionId="two" />);
  expect(signalA.aborted).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  open();
  await screen.findByText('Snapshot partial');
  await act(async () =>
    resolveA(Response.json({ ...contextSnapshotFixture(), status: 'available' })),
  );
  expect(screen.queryByText('Snapshot available')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect((fetch.mock.calls as unknown as [string, RequestInit][])[1][1].signal!.aborted).toBe(true);
});
it.each([AUTH_LOST_EVENT, AUTH_RESTORED_EVENT])(
  'aborts and clears a pending read on %s',
  async (event) => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    render(<ContextSnapshotInspector sessionId="one" />);
    open();
    act(() => window.dispatchEvent(new Event(event)));
    expect((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].signal!.aborted).toBe(
      true,
    );
    await act(async () => resolve(Response.json(contextSnapshotFixture())));
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
it.each([401, 403])(
  'clears retained evidence and disables actions after HTTP %s',
  async (status) => {
    const fetch = respond();
    render(<ContextSnapshotInspector sessionId="one" />);
    open();
    await screen.findByText('Snapshot partial');
    fetch.mockResolvedValueOnce(Response.json({}, { status }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }));
    await waitFor(() => expect(screen.queryByText('12,001 tokens (estimated)')).toBeNull());
    if (status === 403)
      expect(screen.getByRole('button', { name: 'Refresh summary' })).toHaveProperty(
        'disabled',
        true,
      );
  },
);
it.each(['binding', 'revision', 'time'] as const)(
  'discards a refresh with changed %s',
  async (change) => {
    const fetch = respond();
    render(<ContextSnapshotInspector sessionId="one" />);
    open();
    await screen.findByText('Snapshot partial');
    const data = contextSnapshotFixture();
    if (change === 'binding') data.snapshot!.binding.accountRef = 'other-account';
    if (change === 'revision') data.revision = 1;
    if (change === 'time') data.snapshot!.observedAt--;
    fetch.mockResolvedValueOnce(Response.json(data));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('12,001 tokens (estimated)')).toBeNull();
  },
);

it('invalidates expired evidence locally without another network read', async () => {
  vi.useFakeTimers();
  const data = contextSnapshotFixture();
  data.snapshot!.observedAt = Date.now();
  data.snapshot!.freshness.expiresAt = Date.now() + 1000;
  const fetch = respond(data);
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await act(async () => {});
  expect(screen.getByText('Snapshot partial')).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(1001);
  });
  expect(screen.getByText('stale · observation expired')).toBeTruthy();
  expect(screen.getByText(/Capacity is stale or unverified/)).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds a hung read and rejects its late response without retrying', async () => {
  vi.useFakeTimers();
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await act(async () => {
    vi.advanceTimersByTime(10000);
  });
  expect(screen.getByRole('alert').textContent).toContain('timed out');
  await act(async () => resolve(Response.json(contextSnapshotFixture())));
  expect(screen.queryByText('12,001 tokens (estimated)')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves full-request uncertainty and requires new consent after a new passive read', async () => {
  const fetch = respond();
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText('Snapshot partial');
  fireEvent.click(screen.getByRole('button', { name: 'Full detail…' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fetch.mockRejectedValueOnce(new TypeError('private upstream payload'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh full detail' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain('Token-count work may have occurred');
  expect(document.body.textContent).not.toContain('private upstream payload');
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
    'private upstream payload',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved snapshot' }));
  await screen.findByText('Snapshot partial');
  fireEvent.click(screen.getByRole('button', { name: 'Full detail…' }));
  expect(screen.getByRole('checkbox')).toHaveProperty('checked', false);
  expect(screen.getByRole('button', { name: 'Refresh full detail' })).toHaveProperty(
    'disabled',
    true,
  );
});
it('discards a superseded body even when transport ignores abort', async () => {
  let resolveBody!: (value: unknown) => void;
  const fetch = respond();
  render(<ContextSnapshotInspector sessionId="one" />);
  open();
  await screen.findByText('Snapshot partial');
  fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      new Promise((done) => {
        resolveBody = done;
      }),
  } as Response);
  fireEvent.click(screen.getByRole('button', { name: 'Read saved snapshot' }));
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  open();
  await screen.findByText('Snapshot partial');
  await act(async () => resolveBody({ ...contextSnapshotFixture(), status: 'available' }));
  expect(screen.queryByText('Snapshot available')).toBeNull();
});
it('aborts an inspection when its participant becomes unavailable', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const view = render(<ContextSnapshotInspector sessionId="one" />);
  open();
  view.rerender(<ContextSnapshotInspector sessionId="one" disabled />);
  expect((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].signal!.aborted).toBe(true);
  await act(async () => resolve(Response.json(contextSnapshotFixture())));
  expect(screen.queryByRole('dialog')).toBeNull();
});
