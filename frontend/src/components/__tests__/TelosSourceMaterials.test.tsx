// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PermissionBanner } from '../PermissionBanner';

const api = vi.hoisted(() => ({
  getSourcePermission: vi.fn(),
  getSourceMaterials: vi.fn(),
  previewSourcePermission: vi.fn(),
  approveSourcePermission: vi.fn(),
}));
vi.mock('@mitzo/client', () => ({
  TelosWorkApiClient: class {
    getSourcePermission = api.getSourcePermission;
    getSourceMaterials = api.getSourceMaterials;
    previewSourcePermission = api.previewSourcePermission;
    approveSourcePermission = api.approveSourcePermission;
  },
}));
const cursor = { createdAt: '2026-10-17T00:00:00Z', artifactId: 'material', revision: 100 };
const artifact = (revision: number) => ({
  artifactId: 'material',
  revision,
  sha256: String(revision % 10).repeat(64),
  title: 'Retained plan',
  filename: 'plan.md',
  sizeBytes: 20,
  createdAt: cursor.createdAt,
  sessionId: 'planning',
});
const review = {
  permId: 'material-permission',
  sessionId: 'planning',
  toolUseId: 'material-invocation',
  expiresAt: Date.now() + 120000,
  proposalSha256: 'a'.repeat(64),
  operation: {
    kind: 'create',
    outcome: {
      summary: 'Plan',
      intent: 'Retain plan',
      rationale: 'Keep exact source',
      acceptanceCriteria: ['Reviewed'],
      milestones: [],
      profile: 'personal',
    },
  },
  source: {
    conversationId: 'planning',
    title: 'Plan discussion',
    boundary: { sequence: 8, messageId: 'agreed' },
  },
  messages: [
    {
      messageId: 'agreed',
      sequence: 8,
      author: 'assistant',
      blocks: [{ blockId: 'text', content: 'Agreed source.', sha256: 'f'.repeat(64) }],
      attribution: null,
      unavailableReason: null,
    },
  ],
  artifacts: [artifact(1)],
  cursor: 8,
  hasMore: true,
  artifactCursor: cursor,
  artifactsHasMore: true,
};
const props = {
  permId: review.permId,
  sessionId: review.sessionId,
  reviewKind: 'telos_source' as const,
  toolName: 'TelosCreateOutcome',
  toolInput: '{}',
  expiresAt: review.expiresAt,
  onRespond: vi.fn(),
};
const materialPage = {
  permId: review.permId,
  sessionId: review.sessionId,
  toolUseId: review.toolUseId,
  proposalSha256: review.proposalSha256,
  artifacts: [artifact(150)],
  cursor: { ...cursor, revision: 150 },
  hasMore: false,
};
const surface = () => render(<PermissionBanner {...props} />, { wrapper: MemoryRouter });
beforeEach(() => {
  vi.clearAllMocks();
  window.dispatchEvent(new Event('mitzo:auth-lost'));
  api.getSourcePermission.mockReset().mockResolvedValue(review);
  api.getSourceMaterials.mockReset().mockResolvedValue(materialPage);
  api.previewSourcePermission.mockReset().mockImplementation(async (_id, input) => ({
    permId: review.permId,
    sessionId: review.sessionId,
    requestId: input.requestId,
    proposalSha256: review.proposalSha256,
    preview: {
      sha256: 'b'.repeat(64),
      packet: {
        brief: { text: 'Plan' },
        context: { boundary: review.source.boundary, messages: [], artifacts: [] },
      },
    },
  }));
});
afterEach(cleanup);

it('loads exact material revisions independently, keeps choices and preserves them through message pagination', async () => {
  api.getSourcePermission.mockResolvedValueOnce(review).mockResolvedValueOnce({
    ...review,
    cursor: 9,
    hasMore: false,
    messages: [
      {
        ...review.messages[0],
        messageId: 'later',
        sequence: 9,
        blocks: [{ blockId: 'later-text', content: 'Later source.', sha256: 'e'.repeat(64) }],
      },
    ],
  });
  surface();
  const chosen = await screen.findByRole('checkbox', { name: /Retained plan.*revision 1 / });
  fireEvent.click(chosen);
  fireEvent.click(screen.getByRole('checkbox', { name: /Agreed source/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more retained materials' }));
  const old = await screen.findByRole('checkbox', { name: /Retained plan.*revision 150 / });
  expect((chosen as HTMLInputElement).checked).toBe(true);
  expect((old as HTMLInputElement).checked).toBe(false);
  expect(api.getSourceMaterials.mock.calls[0][1]).toEqual({
    sessionId: review.sessionId,
    toolUseId: review.toolUseId,
    proposalSha256: review.proposalSha256,
    after: cursor,
  });
  expect(api.getSourceMaterials.mock.calls[0][2].aborted).toBe(false);
  fireEvent.click(old);
  fireEvent.click(screen.getByRole('button', { name: 'Load more source messages' }));
  await screen.findByRole('checkbox', { name: /Later source/ });
  expect(
    (screen.getByRole('checkbox', { name: /revision 150 / }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(screen.queryByRole('button', { name: 'Load more retained materials' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
  await screen.findByText('Reviewed source');
  expect(api.previewSourcePermission.mock.calls[0][1].selection.artifacts).toEqual(
    [artifact(1), artifact(150)].map(({ artifactId, revision, sha256 }) => ({
      artifactId,
      revision,
      sha256,
    })),
  );
  expect(api.approveSourcePermission).not.toHaveBeenCalled();
});

it('merges concurrent message/material replies without either overwriting the other collection', async () => {
  let finishMessage!: (v: unknown) => void;
  let finishMaterial!: (v: unknown) => void;
  api.getSourcePermission.mockResolvedValueOnce(review).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishMessage = resolve;
      }),
  );
  api.getSourceMaterials.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishMaterial = resolve;
      }),
  );
  surface();
  await screen.findByRole('checkbox', { name: /Agreed source/ });
  fireEvent.click(screen.getByRole('button', { name: 'Load more source messages' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load more retained materials' }));
  const messageSignal = api.getSourcePermission.mock.calls[1][2];
  const materialSignal = api.getSourceMaterials.mock.calls[0][2];
  expect(messageSignal).not.toBe(materialSignal);
  expect(messageSignal.aborted).toBe(false);
  await act(async () => finishMaterial(materialPage));
  await act(async () =>
    finishMessage({
      ...review,
      cursor: 9,
      hasMore: false,
      messages: [
        {
          ...review.messages[0],
          messageId: 'later',
          sequence: 9,
          blocks: [
            { blockId: 'later-text', content: 'Concurrent later source.', sha256: 'e'.repeat(64) },
          ],
        },
      ],
    }),
  );
  expect(screen.getByRole('checkbox', { name: /Concurrent later source/ })).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: /revision 150 / })).toBeTruthy();
  expect(api.previewSourcePermission).not.toHaveBeenCalled();
});

it.each(['session', 'auth', 'unmount'] as const)(
  'aborts material ownership on %s change and ignores a late reply',
  async (change) => {
    let finish!: (v: unknown) => void;
    api.getSourceMaterials.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = surface();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
    const signal = api.getSourceMaterials.mock.calls[0][2];
    expect(signal.aborted).toBe(false);
    if (change === 'session')
      view.rerender(<PermissionBanner {...props} sessionId="other" permId="other" />);
    else if (change === 'auth') act(() => window.dispatchEvent(new Event('mitzo:auth-lost')));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(materialPage));
    expect(screen.queryByRole('checkbox', { name: /revision 150 / })).toBeNull();
    expect(api.approveSourcePermission).not.toHaveBeenCalled();
  },
);

it('invalidates an old material page on selection change and retries with fresh ownership', async () => {
  let finish!: (v: unknown) => void;
  api.getSourceMaterials
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(materialPage);
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  const first = api.getSourceMaterials.mock.calls[0][2];
  fireEvent.click(screen.getByRole('checkbox', { name: /Agreed source/ }));
  expect(first.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Load more retained materials' }));
  await screen.findByRole('checkbox', { name: /revision 150 / });
  await act(async () => finish({ ...materialPage, artifacts: [artifact(200)] }));
  expect(screen.queryByRole('checkbox', { name: /revision 200 / })).toBeNull();
  expect(api.getSourceMaterials.mock.calls[1][2].aborted).toBe(false);
  expect(
    (screen.getByRole('checkbox', { name: /Agreed source/ }) as HTMLInputElement).checked,
  ).toBe(true);
});

it.each(['permId', 'sessionId', 'toolUseId', 'proposalSha256'] as const)(
  'rejects a material page for a different %s without replacing pins',
  async (field) => {
    api.getSourceMaterials.mockResolvedValueOnce({ ...materialPage, [field]: 'changed' });
    surface();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('checkbox', { name: /revision 150 / })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /revision 1 / })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Load more retained materials' }).hasAttribute('disabled'),
    ).toBe(false);
  },
);

it('keeps accumulated rows on failed material load and permits text-only preview', async () => {
  api.getSourceMaterials.mockRejectedValueOnce(Error('Read failed'));
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('checkbox', { name: /Agreed source/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
  await screen.findByText('Reviewed source');
  expect(api.previewSourcePermission.mock.calls[0][1].selection.artifacts).toEqual([]);
});

it('offers material continuation even if the current accessible rows are empty', async () => {
  api.getSourcePermission.mockResolvedValueOnce({ ...review, artifacts: [] });
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  await screen.findByRole('checkbox', { name: /revision 150 / });
});

it('keeps a displayed exact preview while discovering rows, invalidating only when another choice is made', async () => {
  surface();
  fireEvent.click(await screen.findByRole('checkbox', { name: /Agreed source/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
  await screen.findByText('Reviewed source');
  fireEvent.click(screen.getByRole('button', { name: 'Load more retained materials' }));
  const later = await screen.findByRole('checkbox', { name: /revision 150 / });
  expect(screen.getByText('Reviewed source')).toBeTruthy();
  expect(api.previewSourcePermission).toHaveBeenCalledTimes(1);
  fireEvent.click(later);
  expect(screen.queryByText('Reviewed source')).toBeNull();
});
it('rejects a repeated seek cursor without replacing pins or trapping retry', async () => {
  api.getSourceMaterials
    .mockResolvedValueOnce({ ...materialPage, cursor })
    .mockResolvedValueOnce(materialPage);
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('checkbox', { name: /revision 150 / })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load more retained materials' }));
  await screen.findByRole('checkbox', { name: /revision 150 / });
});
it('clears protected review on an actual material-page authorization refusal', async () => {
  api.getSourceMaterials.mockRejectedValueOnce({ status: 403, code: 'unauthorized' });
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Sign in again/));
  expect(screen.queryByRole('checkbox', { name: /Agreed source/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Allow Once' }).hasAttribute('disabled')).toBe(true);
});
it('does not let the old material request finally unlock a newer pending page', async () => {
  let failFirst!: (e: Error) => void;
  let finishSecond!: (v: unknown) => void;
  api.getSourceMaterials
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
  surface();
  fireEvent.click(await screen.findByRole('button', { name: 'Load more retained materials' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Agreed source/ }));
  const button = screen.getByRole('button', { name: 'Load more retained materials' });
  fireEvent.click(button);
  await act(async () => failFirst(Error('Old aborted request')));
  expect(button.hasAttribute('disabled')).toBe(true);
  await act(async () => finishSecond(materialPage));
  expect(screen.getByRole('checkbox', { name: /revision 150 / })).toBeTruthy();
});
