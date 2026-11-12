// @vitest-environment jsdom
import {
  approvalAction,
  queryApprovalAction,
  findApprovalAction,
} from '../../components/__tests__/approval-action-helper';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UnifiedInboxView } from '../UnifiedInboxView';
import { apiFetch } from '../../lib/api-fetch';
const events = vi.hoisted(() => new Map<string, () => void>());
const mutate = vi.fn(),
  refresh = vi.fn();
vi.mock('../../components/NotificationProvider', () => ({
  useNotifications: () => ({ mutate, refresh, feed: { needsYou: 1 } }),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  AUTH_LOST_EVENT: 'auth-lost',
  AUTH_RESTORED_EVENT: 'auth-restored',
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: (name: string, handler: () => void) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
  },
}));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (s: object) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
const request = {
  id: 'permission:p',
  kind: 'approval',
  permId: 'p',
  sessionId: 's',
  title: 'Read the repository?',
  body: 'README update',
  createdAt: Date.now(),
  resolvedAt: null,
  readAt: null,
  resolution: null,
  request: { toolName: 'Read', toolInput: 'README.md' },
};
const suggestion = {
  id: 'inbox:idea.md',
  kind: 'update',
  title: 'Connect the budget decisions',
  body: 'Related notes',
  inboxFilename: 'idea.md',
  createdAt: Date.now(),
  resolvedAt: null,
  readAt: null,
  resolution: null,
  inbox: {
    agent: 'troubadour',
    category: 'proposal',
    severity: 'info',
    needsAttention: false,
    status: 'pending',
    tags: ['command_center', 'cross-reference'],
    content: '# Full evidence\n\nA useful explanation.',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mutate.mockResolvedValue(undefined);
  refresh.mockResolvedValue(undefined);
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).includes('/records/')
            ? suggestion
            : { items: [request], total: 1, needsYou: 1, sources: ['troubadour'] },
        ),
      ),
  );
});
afterEach(cleanup);
function show(path = '/inbox') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <UnifiedInboxView />
    </MemoryRouter>,
  );
}
describe('combined Inbox', () => {
  it.each(['once', 'always', 'deny'])(
    'responds %s directly from the Inbox entry',
    async (decision) => {
      show();
      const button = await findApprovalAction(
        decision === 'once'
          ? 'Approve once'
          : decision === 'always'
            ? 'Approve for session'
            : 'Deny',
      );
      fireEvent.click(button);
      await waitFor(() =>
        expect(mutate).toHaveBeenCalledWith('/permission%3Ap/respond', {
          sessionId: 's',
          decision,
        }),
      );
      expect(apiFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/records/'),
        expect.anything(),
      );
    },
  );

  it('keeps detail decisions before long request details', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('/records/')
              ? {
                  ...request,
                  request: { ...request.request, toolInput: 'Long scope\n'.repeat(100) },
                }
              : { items: [request], total: 1, needsYou: 1, sources: [] },
          ),
        ),
    );
    show('/inbox?notice=permission:p');
    const allow = await findApprovalAction('Approve once');
    const details = screen.getByRole('button', { name: 'Request details' });
    expect(allow.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
  });

  it.each([
    { resolution: 'allowed', resolvedAt: 1 },
    { archivedAt: 1 },
    { expiresAt: Date.now() - 1000 },
    { kind: 'question', request: { questions: [{ id: 'q', question: 'Which?', options: [] }] } },
  ])('keeps unavailable and question decisions out of the list: %j', async (state) => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [{ ...request, ...state }],
          total: 1,
          needsYou: 0,
          sources: [],
        }),
      ),
    );
    show();
    await findApprovalAction('Read the repository?');
    expect(queryApprovalAction('Approve once')).not.toBeInTheDocument();
  });

  it('retains the entry and visible error when a direct decision fails', async () => {
    let finishRefresh!: (response: Response) => void;
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [request], total: 1, needsYou: 1, sources: [] })),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          }),
      );
    mutate.mockRejectedValue(new Error('Approval expired. Refresh the request.'));
    show();
    fireEvent.click(await findApprovalAction('Approve once'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Approval expired. Refresh the request.',
    );
    expect(approvalAction('Read the repository?')).toBeVisible();
    await waitFor(() => expect(finishRefresh).toBeDefined());
    await act(async () =>
      finishRefresh(
        new Response(JSON.stringify({ items: [request], total: 1, needsYou: 1, sources: [] })),
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Approval expired. Refresh the request.');
    expect(approvalAction('Approve once')).toBeEnabled();
    mutate.mockResolvedValueOnce(undefined);
    fireEvent.click(approvalAction('Approve once'));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
  });

  it.each([
    { allowSessionGrant: false, hidden: 'Approve for session', visible: 'Approve once' },
    { approvalScope: 'conversation', hidden: 'Approve once', visible: 'Grant to conversation' },
  ])(
    'retains the server decision scope on the entry: %j',
    async ({ hidden, visible, ...scope }) => {
      vi.mocked(apiFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [{ ...request, request: { ...request.request, ...scope } }],
            total: 1,
            needsYou: 1,
            sources: [],
          }),
        ),
      );
      show();
      expect(await findApprovalAction(visible)).toBeVisible();
      expect(queryApprovalAction(hidden)).not.toBeInTheDocument();
    },
  );

  it('disables direct decisions while the response is pending', async () => {
    let settle!: () => void;
    mutate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    show();
    const once = await findApprovalAction('Approve once');
    fireEvent.click(once);
    fireEvent.click(once);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(once).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More approval actions' })).toBeDisabled();
    await act(async () => settle());
  });

  it('keeps legacy file paths in evidence instead of making them the list summary', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              ...suggestion,
              body: 'Files: command_center/lib/todo/store.py ↔ memory/Sessions/budget.md',
            },
          ],
          total: 1,
          needsYou: 0,
          sources: ['troubadour'],
        }),
      ),
    );
    show('/inbox?view=proposals');
    expect(await findApprovalAction('Connect the budget decisions')).toBeVisible();
    expect(screen.queryByText(/command_center\/lib\/todo/)).not.toBeInTheDocument();
  });
  it('rejects a late private detail response after authentication is lost', async () => {
    let reply!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      String(path).includes('/records/')
        ? new Promise<Response>((resolve) => {
            reply = resolve;
          })
        : new Response(JSON.stringify({ items: [], total: 0, needsYou: 1, sources: [] })),
    );
    show('/inbox?notice=permission:p');
    await waitFor(() => expect(reply).toBeDefined());
    await act(async () => {
      window.dispatchEvent(new Event('auth-lost'));
      reply(new Response(JSON.stringify(request)));
    });
    expect(queryApprovalAction('Approve once')).not.toBeInTheDocument();
    expect(screen.queryByText('Read the repository?')).not.toBeInTheDocument();
  });
  it('defaults to Needs you and keeps technical tags out of the list', async () => {
    show();
    expect(await screen.findByRole('heading', { name: /^Inbox/ })).toBeVisible();
    expect(await findApprovalAction('Read the repository?')).toBeVisible();
    expect(approvalAction(/Needs you/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('command_center')).not.toBeInTheDocument();
  });
  it('searches the whole Inbox and resets pagination when a refinement changes', async () => {
    show('/inbox?view=all&offset=50');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'OpenShell' } });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/query=OpenShell.*offset=0/),
        expect.anything(),
      ),
    );
    fireEvent.click(approvalAction('Filters'));
    expect(screen.getByLabelText('Source')).toBeVisible();
    expect(screen.getByLabelText('Status')).toBeVisible();
  });
  it('opens full content through old file links and offers recoverable archive with undo', async () => {
    show('/inbox?item=idea.md');
    expect(await screen.findByText('A useful explanation.')).toBeVisible();
    fireEvent.click(approvalAction('Archive'));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/inbox%3Aidea.md/archive'));
    fireEvent.click(await findApprovalAction('Undo'));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/inbox%3Aidea.md/restore'));
  });
  it('retains authenticated one-shot responses rather than resolving by reading', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('/records/')
              ? request
              : { items: [request], total: 1, needsYou: 1, sources: [] },
          ),
        ),
    );
    show('/inbox?notice=permission:p');
    fireEvent.click(await findApprovalAction('Approve once'));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        '/permission%3Ap/respond',
        expect.objectContaining({ sessionId: 's', decision: 'once' }),
      ),
    );
  });
});

describe('live detail and pagination reconciliation', () => {
  it('refreshes an open request when another client resolves it', async () => {
    let resolved = false;
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('/records/')
              ? {
                  ...request,
                  resolvedAt: resolved ? 1 : null,
                  resolution: resolved ? 'allowed' : null,
                }
              : { items: [], total: 0, needsYou: resolved ? 0 : 1, sources: [] },
          ),
        ),
    );
    show('/inbox?notice=permission:p');
    expect(await findApprovalAction('Approve once')).toBeVisible();
    resolved = true;
    act(() => events.get('notifications_changed')!());
    await waitFor(() => expect(queryApprovalAction('Approve once')).not.toBeInTheDocument());
  });
  it('refreshes stale request controls after a rejected response', async () => {
    let resolved = false;
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('/records/')
              ? {
                  ...request,
                  resolvedAt: resolved ? 1 : null,
                  resolution: resolved ? 'denied' : null,
                }
              : { items: [], total: 0, needsYou: 0, sources: [] },
          ),
        ),
    );
    mutate.mockImplementation(async (path: string) => {
      if (path.endsWith('/respond')) {
        resolved = true;
        throw new Error('Already answered');
      }
    });
    show('/inbox?notice=permission:p');
    fireEvent.click(await findApprovalAction('Approve once'));
    await waitFor(() => expect(queryApprovalAction('Approve once')).not.toBeInTheDocument());
  });
  it('clamps a shrunken last page so the remaining records can be reached', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('offset=50')
              ? { items: [], total: 50, needsYou: 0, sources: [] }
              : { items: [suggestion], total: 50, needsYou: 0, sources: [] },
          ),
        ),
    );
    show('/inbox?view=all&offset=50');
    expect(await findApprovalAction(suggestion.title)).toBeVisible();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('offset=0'), expect.anything());
  });
  it('records a new read receipt for reopened evidence with the same ID', async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).includes('/records/')
              ? suggestion
              : { items: [], total: 0, needsYou: 0, sources: [] },
          ),
        ),
    );
    show('/inbox?notice=inbox:idea.md');
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/inbox%3Aidea.md/read'));
    await act(async () => {});
    mutate.mockClear();
    act(() => events.get('inbox_updated')!());
    await waitFor(() => expect(mutate).toHaveBeenCalledWith('/inbox%3Aidea.md/read'));
  });
});
