// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { PermissionBanner } from '../PermissionBanner';
import { subscribeTelosSourceSaves } from '../../lib/telos-source-updates';

const render = (ui: ReactElement) => baseRender(ui, { wrapper: MemoryRouter });

const api = vi.hoisted(() => ({
  getSourcePermission: vi.fn(),
  previewSourcePermission: vi.fn(),
  approveSourcePermission: vi.fn(),
}));
vi.mock('@mitzo/client', () => ({
  TelosWorkApiClient: class {
    getSourcePermission = api.getSourcePermission;
    previewSourcePermission = api.previewSourcePermission;
    approveSourcePermission = api.approveSourcePermission;
  },
}));

const proposalSha256 = 'a'.repeat(64);
const previewSha256 = 'b'.repeat(64);
const review = {
  permId: 'review-permission',
  sessionId: 'planning-chat',
  toolUseId: 'tool-one',
  expiresAt: Date.now() + 120_000,
  proposalSha256,
  operation: {
    kind: 'create',
    outcome: {
      summary: 'Home studio',
      intent: 'Record the first studio session.',
      rationale: 'Make reliable practice recordings.',
      acceptanceCriteria: ['A first recording is retained.'],
      milestones: ['Agree the layout.'],
      profile: 'personal',
    },
  },
  source: {
    conversationId: 'planning-chat',
    title: 'Studio discussion',
    boundary: { sequence: 8, messageId: 'assistant-1' },
  },
  messages: [
    {
      messageId: 'assistant-1',
      sequence: 8,
      author: 'assistant',
      blocks: [{ blockId: 'text-1', content: 'The agreed studio brief.', sha256: 'c'.repeat(64) }],
      attribution: null,
    },
  ],
  artifacts: [
    {
      artifactId: 'material-one',
      revision: 3,
      sha256: 'd'.repeat(64),
      title: 'Layout plan',
      filename: 'plan.md',
      sizeBytes: 42,
    },
  ],
};
const props = {
  permId: review.permId,
  sessionId: review.sessionId,
  reviewKind: 'telos_source' as const,
  toolName: 'TelosCreateOutcome',
  toolInput: '{"summary":"Home studio"}',
  expiresAt: Date.now() + 120_000,
  onRespond: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  api.getSourcePermission.mockReset();
  api.getSourcePermission.mockResolvedValue(review);
  api.previewSourcePermission.mockImplementation(async (_id, input) => ({
    permId: review.permId,
    sessionId: review.sessionId,
    requestId: input.requestId,
    proposalSha256,
    preview: {
      sha256: previewSha256,
      packet: {
        brief: { text: 'Home studio approved proposal' },
        context: {
          boundary: review.source.boundary,
          messages: [
            {
              messageId: 'assistant-1',
              blocks: [{ blockId: 'text-1', content: 'The agreed studio brief.' }],
            },
          ],
          artifacts: [],
        },
      },
    },
  }));
  api.approveSourcePermission.mockResolvedValue({
    permId: review.permId,
    sessionId: review.sessionId,
    receipt: { work: { itemId: 'studio' } },
    sourceSnapshotId: 'snapshot-one',
  });
});
afterEach(cleanup);

it.each([false, true])(
  'announces a late confirmed receipt after banner removal only in the same login (auth lost: %s)',
  async (authLost) => {
    let finish!: (value: unknown) => void;
    api.approveSourcePermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const notified = vi.fn();
    const unsubscribe = subscribeTelosSourceSaves(notified);
    try {
      const banner = render(<PermissionBanner {...props} />);
      await selectAndPreview();
      fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
      await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
      banner.unmount();
      if (authLost) act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
      await act(async () =>
        finish({
          permId: review.permId,
          sessionId: review.sessionId,
          receipt: { work: { itemId: 'studio' } },
          sourceSnapshotId: 'snapshot-one',
        }),
      );
      expect(notified).toHaveBeenCalledTimes(authLost ? 0 : 1);
      if (!authLost)
        expect(notified).toHaveBeenCalledWith({
          conversationId: review.sessionId,
          itemId: 'studio',
        });
    } finally {
      unsubscribe();
    }
  },
);

it('announces a shared pending approval receipt once across banner replacement', async () => {
  let finish!: (value: unknown) => void;
  api.approveSourcePermission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const notified = vi.fn();
  const unsubscribe = subscribeTelosSourceSaves(notified);
  try {
    const first = render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
    const originalInput = api.approveSourcePermission.mock.calls[0][1];
    first.unmount();
    render(<PermissionBanner {...props} />);
    await screen.findByText('Reviewed source');
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(api.approveSourcePermission).toHaveBeenCalledTimes(1);
    await act(async () =>
      finish({
        permId: review.permId,
        sessionId: review.sessionId,
        receipt: { work: { itemId: 'studio' } },
        sourceSnapshotId: 'snapshot-one',
      }),
    );
    await screen.findByRole('link', { name: 'Open saved item' });
    expect(api.approveSourcePermission.mock.calls[0][1]).toEqual(originalInput);
    expect(notified).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

it.each(['permId', 'sessionId'] as const)(
  'never announces a late receipt for a different %s after banner removal',
  async (field) => {
    let finish!: (value: unknown) => void;
    api.approveSourcePermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const notified = vi.fn();
    const unsubscribe = subscribeTelosSourceSaves(notified);
    try {
      const banner = render(<PermissionBanner {...props} />);
      await selectAndPreview();
      fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
      await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
      banner.unmount();
      await act(async () =>
        finish({
          permId: review.permId,
          sessionId: review.sessionId,
          receipt: { work: { itemId: 'studio' } },
          sourceSnapshotId: 'snapshot-one',
          [field]: 'different-owner',
        }),
      );
      expect(notified).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  },
);

async function selectAndPreview() {
  fireEvent.click(await screen.findByRole('checkbox', { name: /The agreed studio brief/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
  await screen.findByText('Reviewed source');
}

describe('ordinary Telos source approval', () => {
  it('leads with a friendly heading and one readable Telos brief while technical provenance stays collapsed', async () => {
    render(<PermissionBanner {...props} toolName="mcp__telos__TelosCreateOutcome" />);
    await screen.findByRole('checkbox', { name: /The agreed studio brief/ });
    expect(screen.getByRole('heading', { name: 'Save to Telos' })).toBeTruthy();
    expect(screen.getByText('Outcome')).toBeTruthy();
    expect(screen.getAllByText('Record the first studio session.')).toHaveLength(1);
    expect(screen.getByText('Why this matters')).toBeTruthy();
    expect(screen.getByText('Done when')).toBeTruthy();
    expect(screen.getByText('Milestones')).toBeTruthy();
    expect(screen.queryByText(/Seat unknown · generation unknown/)).toBeNull();
    expect(screen.getByText('Source details').closest('details')?.open).toBe(false);
    expect(screen.queryByRole('heading', { name: /mcp__/ })).toBeNull();
  });
  it('does not infer source authority from a tool name without the host marker', () => {
    render(<PermissionBanner {...props} reviewKind={undefined} />);
    expect(screen.getByRole('button', { name: 'Allow for session' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    expect(props.onRespond).toHaveBeenCalledWith(review.permId, 'once', props.toolName);
    expect(api.getSourcePermission).not.toHaveBeenCalled();
  });

  it('starts empty, keeps approval in the existing card, and offers no future-source session grant', async () => {
    render(<PermissionBanner {...props} />);
    const source = await screen.findByRole('checkbox', { name: /The agreed studio brief/ });
    expect((source as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull();
    expect(source.closest('details')?.querySelector('summary')?.textContent).toContain(
      'Request details',
    );
    expect(screen.getByLabelText('Approval required').parentElement).toBe(document.body);
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
  });

  it('submits the exact reviewed selection and digest through the operator API instead of generic allow', async () => {
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    expect(screen.getByText(/Boundary.*8/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
    const input = api.previewSourcePermission.mock.calls[0][1];
    expect(input.selection.messageIds).toEqual(['assistant-1']);
    expect(input.selection.artifacts).toEqual([]);
    expect(api.approveSourcePermission.mock.calls[0]).toEqual([
      review.permId,
      { ...input, previewSha256 },
    ]);
    expect(props.onRespond).not.toHaveBeenCalled();
  });

  it('invalidates review when the selected material changes and preserves exact material versions', async () => {
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('checkbox', { name: /Layout plan/ }));
    expect(screen.queryByText('Reviewed source')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
    await screen.findByText('Reviewed source');
    expect(api.previewSourcePermission.mock.calls[1][1].selection.artifacts).toEqual([
      { artifactId: 'material-one', revision: 3, sha256: 'd'.repeat(64) },
    ]);
  });

  it('fences late candidate responses when the selected session changes', async () => {
    let finish!: (value: unknown) => void;
    api.getSourcePermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(<PermissionBanner {...props} />);
    await waitFor(() => expect(api.getSourcePermission).toHaveBeenCalledTimes(1));
    rerender(<PermissionBanner {...props} sessionId="another-chat" permId="another-permission" />);
    await act(async () => finish(review));
    expect(screen.queryByRole('checkbox', { name: /The agreed studio brief/ })).toBeNull();
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('keeps the same prepared request after an uncertain save and retries it without widening selection', async () => {
    api.approveSourcePermission.mockRejectedValueOnce(new Error('Connection lost'));
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await screen.findByRole('alert');
    expect(
      screen.getByRole('checkbox', { name: /The agreed studio brief/ }).matches(':disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(2));
    expect(api.approveSourcePermission.mock.calls[1]).toEqual(
      api.approveSourcePermission.mock.calls[0],
    );
  });

  it('denies through the existing permission response without preparing a save', async () => {
    render(<PermissionBanner {...props} />);
    await screen.findByRole('checkbox', { name: /The agreed studio brief/ });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(props.onRespond).toHaveBeenCalledWith(review.permId, 'deny', props.toolName);
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('shows the exact existing-item target for an explicit adoption request', async () => {
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      operation: { kind: 'adopt', itemId: 'existing-studio', expectedRevision: 'e'.repeat(64) },
    });
    render(<PermissionBanner {...props} toolName="TelosAdoptSource" />);
    await screen.findByText('Add source to existing item · existing-studio');
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull();
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
  });

  it('anchors an earlier selected exchange instead of a later unselected message', async () => {
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      source: { ...review.source, boundary: { sequence: 20, messageId: 'later' } },
      messages: [
        ...review.messages,
        {
          ...review.messages[0],
          messageId: 'later',
          sequence: 20,
          blocks: [
            {
              blockId: 'later-text',
              content: 'A later unrelated exchange.',
              sha256: 'f'.repeat(64),
            },
          ],
        },
      ],
    });
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    expect(api.previewSourcePermission.mock.calls[0][1].selection.boundary).toEqual({
      sequence: 8,
      messageId: 'assistant-1',
    });
  });

  it('fences a late preview on authentication loss and cannot approve its digest', async () => {
    let finish!: (value: unknown) => void;
    const original = api.previewSourcePermission.getMockImplementation()!;
    api.previewSourcePermission.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<PermissionBanner {...props} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /The agreed studio brief/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
    const input = api.previewSourcePermission.mock.calls[0][1];
    await act(async () => {
      window.dispatchEvent(new Event('mitzo:auth-lost'));
      finish(await original(review.permId, input));
    });
    expect(screen.queryByText('Reviewed source')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('removes an expired review without treating expiry as a user denial or save', async () => {
    const { rerender } = render(<PermissionBanner {...props} />);
    await selectAndPreview();
    rerender(<PermissionBanner {...props} expiresAt={Date.now() - 1} />);
    expect(screen.queryByLabelText('Approval required')).toBeNull();
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
    expect(props.onRespond).not.toHaveBeenCalled();
  });

  it('recovers the exact attempted save across card removal before its HTTP failure arrives', async () => {
    let fail!: (error: Error) => void;
    api.approveSourcePermission.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const first = render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
    const input = api.approveSourcePermission.mock.calls[0][1];
    first.unmount();
    await act(async () => fail(new Error('Lost response')));
    render(<PermissionBanner {...props} />);
    await screen.findByText('Reviewed source');
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(2));
    expect(api.approveSourcePermission.mock.calls[1][1]).toEqual(input);
    expect(api.getSourcePermission).toHaveBeenCalledTimes(2);
  });

  it('restores the server-prepared immutable preview after a reload without creating a new request', async () => {
    const input = {
      sessionId: review.sessionId,
      requestId: '12345678-1234-4234-8234-123456789abc',
      proposalSha256,
      selection: {
        mode: 'selected',
        boundary: review.source.boundary,
        messageIds: ['assistant-1'],
        artifacts: [],
      },
    };
    const originalPreview = await api.previewSourcePermission.getMockImplementation()!(
      review.permId,
      input,
    );
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      messages: [],
      artifacts: [],
      recovery: { ...input, previewSha256, preview: originalPreview.preview, receipt: null },
    });
    render(<PermissionBanner {...props} />);
    await screen.findByText('Reviewed source');
    expect(screen.getByText('The agreed studio brief.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(1));
    expect(api.approveSourcePermission.mock.calls[0][1]).toEqual({ ...input, previewSha256 });
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
  });

  it('shows a recovered confirmed receipt as saved and never saves again', async () => {
    const input = {
      sessionId: review.sessionId,
      requestId: '12345678-1234-4234-8234-123456789abc',
      proposalSha256,
      selection: {
        mode: 'selected',
        boundary: review.source.boundary,
        messageIds: ['assistant-1'],
        artifacts: [],
      },
    };
    const originalPreview = await api.previewSourcePermission.getMockImplementation()!(
      review.permId,
      input,
    );
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      messages: [],
      artifacts: [],
      recovery: {
        ...input,
        previewSha256,
        preview: originalPreview.preview,
        receipt: {
          permId: review.permId,
          sessionId: review.sessionId,
          receipt: { work: { itemId: 'studio' } },
          sourceSnapshotId: 'snapshot-one',
        },
      },
    });
    render(<PermissionBanner {...props} />);
    expect(
      (await screen.findByRole('link', { name: 'Open saved item' })).getAttribute('href'),
    ).toBe('/todos/studio');
    expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('loads additional candidates explicitly while retaining empty selection', async () => {
    api.getSourcePermission
      .mockResolvedValueOnce({ ...review, cursor: 8, hasMore: true })
      .mockResolvedValueOnce({
        ...review,
        cursor: 20,
        hasMore: false,
        messages: [
          {
            ...review.messages[0],
            messageId: 'older-2',
            sequence: 20,
            blocks: [
              {
                blockId: 'older-text',
                content: 'Another completed exchange.',
                sha256: 'f'.repeat(64),
              },
            ],
          },
        ],
      });
    render(<PermissionBanner {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more source messages' }));
    const candidate = await screen.findByRole('checkbox', { name: /Another completed exchange/ });
    expect((candidate as HTMLInputElement).checked).toBe(false);
    expect(api.getSourcePermission.mock.calls[1][3]).toBe(8);
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
  });

  it.each(['message', 'artifact'] as const)(
    'loads another page with a live signal after selecting a %s, preserving explicit choices',
    async (kind) => {
      const next = {
        ...review,
        cursor: 20,
        hasMore: false,
        messages: [
          {
            ...review.messages[0],
            messageId: 'next-page-message',
            sequence: 20,
            blocks: [
              {
                blockId: 'next-page-text',
                content: 'New page, still unselected.',
                sha256: 'f'.repeat(64),
              },
            ],
          },
        ],
      };
      api.getSourcePermission.mockImplementation(
        async (_id, _session, signal: AbortSignal, cursor = 0) => {
          signal.throwIfAborted();
          return cursor === 0 ? { ...review, cursor: 8, hasMore: true } : next;
        },
      );
      render(<PermissionBanner {...props} />);
      const choice = await screen.findByRole('checkbox', {
        name: kind === 'message' ? /The agreed studio brief/ : /Layout plan/,
      });
      fireEvent.click(choice);
      expect((choice as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Load more source messages' }));
      await waitFor(() => expect(api.getSourcePermission).toHaveBeenCalledTimes(2));
      expect(api.getSourcePermission.mock.calls[1][2].aborted).toBe(false);
      expect(api.getSourcePermission.mock.calls[1][2]).not.toBe(
        api.getSourcePermission.mock.calls[0][2],
      );
      const candidate = await screen.findByRole('checkbox', { name: /New page, still unselected/ });
      expect((candidate as HTMLInputElement).checked).toBe(false);
      expect((choice as HTMLInputElement).checked).toBe(true);
      expect(api.getSourcePermission.mock.calls[1][3]).toBe(8);
      expect(screen.queryByText('More source messages are unavailable. Try again.')).toBeNull();
      expect(api.previewSourcePermission).not.toHaveBeenCalled();
      expect(api.approveSourcePermission).not.toHaveBeenCalled();
      expect(props.onRespond).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'auth', 'unmount'] as const)(
    'aborts a pending page on %s change and ignores its late response',
    async (change) => {
      let finish!: (value: unknown) => void;
      let signal!: AbortSignal;
      api.getSourcePermission
        .mockResolvedValueOnce({ ...review, cursor: 8, hasMore: true })
        .mockImplementationOnce((_id, _session, pageSignal: AbortSignal) => {
          signal = pageSignal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        });
      const surface = render(<PermissionBanner {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Load more source messages' }));
      expect(signal.aborted).toBe(false);
      if (change === 'session')
        surface.rerender(
          <PermissionBanner {...props} sessionId="another-chat" permId="another-permission" />,
        );
      else if (change === 'auth') act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
      else surface.unmount();
      expect(signal.aborted).toBe(true);
      await act(async () =>
        finish({
          ...review,
          cursor: 20,
          hasMore: false,
          messages: [
            {
              ...review.messages[0],
              messageId: 'late-page',
              blocks: [
                { blockId: 'late', content: 'Late old-page source', sha256: 'f'.repeat(64) },
              ],
            },
          ],
        }),
      );
      expect(screen.queryByText('Late old-page source')).toBeNull();
      expect(api.previewSourcePermission).not.toHaveBeenCalled();
      expect(api.approveSourcePermission).not.toHaveBeenCalled();
    },
  );

  it('cancels an old page on selection and keeps its cleanup from unlocking a newer page', async () => {
    let finish!: (value: unknown) => void;
    let oldSignal!: AbortSignal;
    let nextSignal!: AbortSignal;
    api.getSourcePermission
      .mockResolvedValueOnce({ ...review, cursor: 8, hasMore: true })
      .mockImplementationOnce((_id, _session, signal: AbortSignal) => {
        oldSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      })
      .mockImplementationOnce((_id, _session, signal: AbortSignal) => {
        signal.throwIfAborted();
        nextSignal = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
    render(<PermissionBanner {...props} />);
    const load = await screen.findByRole('button', { name: 'Load more source messages' });
    fireEvent.click(load);
    const choice = screen.getByRole('checkbox', { name: /The agreed studio brief/ });
    fireEvent.click(choice);
    expect(oldSignal.aborted).toBe(true);
    fireEvent.click(load);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getSourcePermission).toHaveBeenCalledTimes(3);
    expect(nextSignal.aborted).toBe(false);
    fireEvent.click(load);
    expect(api.getSourcePermission).toHaveBeenCalledTimes(3);
    await act(async () =>
      finish({
        ...review,
        cursor: 20,
        hasMore: false,
        messages: [
          {
            ...review.messages[0],
            messageId: 'new-page',
            blocks: [
              { blockId: 'new-page', content: 'Current source page', sha256: 'f'.repeat(64) },
            ],
          },
        ],
      }),
    );
    expect(
      ((await screen.findByRole('checkbox', { name: /Current source page/ })) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect((choice as HTMLInputElement).checked).toBe(true);
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('identifies actual source seat generations while keeping missing provenance explicit', async () => {
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      messages: [
        {
          ...review.messages[0],
          attribution: {
            seatId: 'reviewer',
            provenance: { membershipGeneration: 7, configRevision: 3 },
            createdAt: 1_792_182_000_000,
          },
        },
      ],
    });
    render(<PermissionBanner {...props} />);
    await screen.findByText(/Seat reviewer · generation 7 · configuration 3/);
    expect(screen.queryByText(/Seat unknown/)).toBeNull();
  });

  it('clears visible source context immediately on authentication loss', async () => {
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
    expect(screen.queryByRole('checkbox', { name: /The agreed studio brief/ })).toBeNull();
    expect(screen.queryByText('Reviewed source')).toBeNull();
    expect(screen.queryByText('The agreed studio brief.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
  });

  it('never displays a previous cached preview before a fresh authenticated read', async () => {
    api.approveSourcePermission.mockRejectedValueOnce(new Error('Lost response'));
    const first = render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await screen.findByRole('alert');
    first.unmount();
    api.getSourcePermission.mockRejectedValueOnce({ status: 403, code: 'unauthorized' });
    render(<PermissionBanner {...props} />);
    expect(screen.queryByText('Reviewed source')).toBeNull();
    await screen.findByRole('alert');
    expect(screen.queryByText('The agreed studio brief.')).toBeNull();
    expect(screen.queryByText('Reviewed source')).toBeNull();
  });

  it('recovers an explicitly replayed host card after expiry using Retry same save and Dismiss', async () => {
    const input = {
      sessionId: review.sessionId,
      requestId: '12345678-1234-4234-8234-123456789abc',
      proposalSha256,
      selection: {
        mode: 'selected',
        boundary: review.source.boundary,
        messageIds: ['assistant-1'],
        artifacts: [],
      },
    };
    const originalPreview = await api.previewSourcePermission.getMockImplementation()!(
      review.permId,
      input,
    );
    api.getSourcePermission.mockResolvedValueOnce({
      ...review,
      expiresAt: Date.now() - 1,
      messages: [],
      artifacts: [],
      recovery: { ...input, previewSha256, preview: originalPreview.preview, receipt: null },
    });
    const onExpire = vi.fn();
    render(
      <PermissionBanner
        {...props}
        recoveryOnly={true}
        expiresAt={Date.now() - 1}
        onExpire={onExpire}
      />,
    );
    await screen.findByText('Reviewed source');
    expect(screen.getByLabelText('Save recovery')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Select the agreed exchange' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Select retained materials' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review selected source' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Outcome brief' })).toBeTruthy();
    expect(screen.getByText('Source details')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry same save' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(onExpire).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(props.onRespond).toHaveBeenCalledWith(review.permId, 'deny', props.toolName);
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  });

  it('retries a failed recovery read for the same original save without preparing a replacement', async () => {
    const input = {
      sessionId: review.sessionId,
      requestId: '12345678-1234-4234-8234-123456789abc',
      proposalSha256,
      selection: {
        mode: 'selected',
        boundary: review.source.boundary,
        messageIds: ['assistant-1'],
        artifacts: [],
      },
    };
    const originalPreview = await api.previewSourcePermission.getMockImplementation()!(
      review.permId,
      input,
    );
    api.getSourcePermission
      .mockRejectedValueOnce(new Error('Recovery connection interrupted'))
      .mockResolvedValueOnce({
        ...review,
        messages: [],
        artifacts: [],
        recovery: { ...input, previewSha256, preview: originalPreview.preview, receipt: null },
      });
    render(<PermissionBanner {...props} recoveryOnly expiresAt={Date.now() - 1} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The original save is still unconfirmed');
    expect(alert.textContent).not.toMatch(/deny|ask again|new request/i);
    expect(screen.queryByText('The agreed studio brief.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Retry same save' }).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
    await screen.findByText('Reviewed source');
    expect(
      api.getSourcePermission.mock.calls.map(([permId, sessionId]) => [permId, sessionId]),
    ).toEqual([
      [review.permId, review.sessionId],
      [review.permId, review.sessionId],
    ]);
    expect(api.previewSourcePermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry same save' }));
    await waitFor(() =>
      expect(api.approveSourcePermission).toHaveBeenCalledWith(review.permId, {
        ...input,
        previewSha256,
      }),
    );
    expect(props.onRespond).not.toHaveBeenCalled();
  });

  it.each([
    { status: 409, code: 'conflict' },
    { status: 401, code: 'unauthorized' },
    { status: 403, code: 'unauthorized' },
    { status: 400, code: 'invalid' },
    { status: 404, code: 'not_found' },
  ])(
    'preserves the immutable recovery retry and failure boundary after status $status',
    async ({ status, code }) => {
      const input = {
        sessionId: review.sessionId,
        requestId: '12345678-1234-4234-8234-123456789abc',
        proposalSha256,
        selection: {
          mode: 'selected',
          boundary: review.source.boundary,
          messageIds: ['assistant-1'],
          artifacts: [],
        },
      };
      const originalPreview = await api.previewSourcePermission.getMockImplementation()!(
        review.permId,
        input,
      );
      api.getSourcePermission.mockResolvedValueOnce({
        ...review,
        messages: [],
        artifacts: [],
        recovery: { ...input, previewSha256, preview: originalPreview.preview, receipt: null },
      });
      api.approveSourcePermission.mockRejectedValueOnce({ status, code });
      render(<PermissionBanner {...props} recoveryOnly expiresAt={Date.now() - 1} />);
      await screen.findByText('Reviewed source');
      const retry = screen.getByRole('button', { name: 'Retry same save' });
      fireEvent.click(retry);
      const alert = await screen.findByRole('alert');
      if (status === 401 || status === 403) {
        expect(alert.textContent).toMatch(/sign in again/i);
        expect(retry.hasAttribute('disabled')).toBe(true);
        expect(screen.queryByText('The agreed studio brief.')).toBeNull();
        expect(api.approveSourcePermission).toHaveBeenCalledTimes(1);
        return;
      }
      expect(alert.textContent).not.toMatch(/new request|ask again|review a new/i);
      if (status !== 409) {
        expect(retry.hasAttribute('disabled')).toBe(true);
        expect(api.approveSourcePermission).toHaveBeenCalledTimes(1);
        return;
      }
      expect(alert.textContent).toMatch(/same save|original save/i);
      expect(retry.hasAttribute('disabled')).toBe(false);
      expect(screen.getByText('The agreed studio brief.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
      fireEvent.click(retry);
      await screen.findByRole('link', { name: 'Open saved item' });
      expect(api.approveSourcePermission.mock.calls).toEqual([
        [review.permId, { ...input, previewSha256 }],
        [review.permId, { ...input, previewSha256 }],
      ]);
      expect(api.getSourcePermission).toHaveBeenCalledTimes(1);
      expect(api.previewSourcePermission).not.toHaveBeenCalled();
      expect(props.onRespond).not.toHaveBeenCalled();
    },
  );

  it('retries the exact live durable attempt through conflict without reconnecting or reviewing again', async () => {
    api.approveSourcePermission
      .mockRejectedValueOnce({ status: 503, code: 'save_uncertain' })
      .mockRejectedValueOnce({ status: 409, code: 'conflict' });
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    const allow = screen.getByRole('button', { name: 'Allow Once' });
    fireEvent.click(allow);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Save is unconfirmed/),
    );
    const original = api.approveSourcePermission.mock.calls[0];
    fireEvent.click(allow);
    await waitFor(() => expect(api.approveSourcePermission).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/same save after access returns/),
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /new request|ask again|review a new/i,
    );
    expect(allow.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('alert').textContent).not.toMatch(/Dismiss/);
    expect(screen.getByRole('region', { name: 'Reviewed source' }).textContent).toContain(
      'The agreed studio brief.',
    );
    expect(screen.queryByRole('button', { name: 'Retry same save' })).toBeNull();
    fireEvent.click(allow);
    await screen.findByRole('link', { name: 'Open saved item' });
    expect(api.approveSourcePermission.mock.calls).toEqual([original, original, original]);
    expect(api.previewSourcePermission).toHaveBeenCalledTimes(1);
    expect(api.getSourcePermission).toHaveBeenCalledTimes(1);
    expect(props.onRespond).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'fresh', failure: null },
    { label: 'generic unavailable', failure: { status: 503, code: 'unavailable' } },
    { label: 'network loss', failure: new Error('Network lost') },
    { label: 'unverified save-uncertain', failure: { code: 'save_uncertain' } },
  ])('does not infer durable consent from $label before a live conflict', async ({ failure }) => {
    if (failure) api.approveSourcePermission.mockRejectedValueOnce(failure);
    api.approveSourcePermission.mockRejectedValueOnce({ status: 409, code: 'conflict' });
    render(<PermissionBanner {...props} />);
    await selectAndPreview();
    const allow = screen.getByRole('button', { name: 'Allow Once' });
    if (failure) {
      fireEvent.click(allow);
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/Save is unconfirmed/),
      );
    }
    fireEvent.click(allow);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/original save|original request/i),
    );
    expect(screen.getByRole('alert').textContent).not.toMatch(
      /new request|ask again|review a new/i,
    );
    expect(allow.hasAttribute('disabled')).toBe(true);
    expect(api.approveSourcePermission).toHaveBeenCalledTimes(failure ? 2 : 1);
    expect(api.previewSourcePermission).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 400, code: 'invalid' },
    { status: 404, code: 'not_found' },
    { status: 401, code: 'unauthorized' },
    { status: 403, code: 'unauthorized' },
  ])(
    'keeps definitive live status $status blocked after confirmed durable preparation',
    async ({ status, code }) => {
      api.approveSourcePermission
        .mockRejectedValueOnce({ status: 503, code: 'save_uncertain' })
        .mockRejectedValueOnce({ status, code });
      render(<PermissionBanner {...props} />);
      await selectAndPreview();
      const allow = screen.getByRole('button', { name: 'Allow Once' });
      fireEvent.click(allow);
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/Save is unconfirmed/),
      );
      fireEvent.click(allow);
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(
          status === 401 || status === 403 ? /Sign in again/ : /original save|original request/i,
        ),
      );
      expect(allow.hasAttribute('disabled')).toBe(true);
      expect(api.approveSourcePermission).toHaveBeenCalledTimes(2);
      if (status === 401 || status === 403) {
        expect(screen.getByRole('alert').textContent).toMatch(/Sign in again/);
        expect(screen.queryByText('The agreed studio brief.')).toBeNull();
      }
    },
  );

  it('does not extend the original live deadline after durable preparation', async () => {
    api.approveSourcePermission.mockRejectedValueOnce({ status: 503, code: 'save_uncertain' });
    const { rerender } = render(<PermissionBanner {...props} />);
    await selectAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Save is unconfirmed/),
    );
    rerender(<PermissionBanner {...props} expiresAt={Date.now() - 1} />);
    expect(screen.queryByLabelText('Approval required')).toBeNull();
    expect(screen.queryByLabelText('Save recovery')).toBeNull();
    expect(api.approveSourcePermission).toHaveBeenCalledTimes(1);
    expect(props.onRespond).not.toHaveBeenCalled();
  });
});
