import { PermissionBanner } from '../PermissionBanner';
import type { ReactNode } from 'react';
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosSourcePacket } from '@mitzo/protocol';
import { ChatArea } from '../ChatArea';
import { SourceContext, type SourceNavigation } from '../../hooks/useTelosSourceNavigation';
const messages = ['earlier', 'agreed', 'later'].map((messageId) => ({
  messageId,
  role: 'user' as const,
  blocks: [{ blockId: messageId, blockType: 'text' as const, content: 'Original ' + messageId }],
}));
const request = { itemId: 'item-a', snapshotId: 'source-a', conversationId: 'origin' };
function packet(title = 'Exact created outcome', boundary = 'agreed'): TelosSourcePacket {
  return {
    itemId: null,
    creation: { requestId: title, outcome: { summary: title } },
    context: {
      sourceConversationId: 'origin',
      boundary: { messageId: boundary, sequence: 11 },
      messages: [
        { messageId: 'earlier', sequence: 2 },
        { messageId: boundary, sequence: 11 },
      ],
    },
    selection: { mode: 'selected' },
    attributions: { [boundary]: { provenance: null, seatId: null, createdAt: 1 } },
  } as TelosSourcePacket;
}
function source(itemId = 'item-a', snapshotId = 'source-a') {
  return {
    itemId,
    snapshotId,
    source: { namespace: 'mitzo', conversationId: 'origin' },
    selection: { kind: 'selected' },
  };
}
function setup() {
  vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue(
    ['a', 'b'].map((suffix) => ({
      itemId: 'item-' + suffix,
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: 'origin' },
    })) as never,
  );
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockImplementation(
    async (itemId) => ({ itemId, sources: [source(itemId, 'source-' + itemId.at(-1))] }) as never,
  );
  return vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(
    async (itemId, snapshotId) =>
      ({
        available: true,
        snapshot: source(itemId, snapshotId),
        packet: packet(
          itemId === 'item-a' ? 'Exact created outcome' : 'Second independent outcome',
          itemId === 'item-a' ? 'agreed' : 'earlier',
        ),
      }) as never,
  );
}
function Surface({
  sessionId = 'origin',
  discoverTelosOrigins = true,
  inspected = null,
  extra,
}: {
  sessionId?: string;
  discoverTelosOrigins?: boolean;
  inspected?: SourceNavigation | null;
  extra?: ReactNode;
}) {
  return (
    <MemoryRouter>
      <SourceContext.Provider value={inspected}>
        <textarea aria-label="Unsent draft" defaultValue="Keep original draft" />
        <ChatArea
          sessionId={sessionId}
          discoverTelosOrigins={discoverTelosOrigins}
          messages={messages}
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
        {extra}
      </SourceContext.Provider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('discovers multiple durable origins in an ordinary chat at their own exact exchanges, preserving sparse selection count and original history', async () => {
  setup();
  const view = render(<Surface />);
  const first = await screen.findByRole('link', {
    name: /Exact created outcome.*Created from this exchange/,
  });
  const second = await screen.findByRole('link', {
    name: /Second independent outcome.*Created from this exchange/,
  });
  expect(first.getAttribute('href')).toBe('/todos/item-a?view=Overview');
  expect(second.getAttribute('href')).toBe('/todos/item-b?view=Overview');
  expect(first.textContent).toContain('Selected exchange · 2 messages');
  expect(first.textContent).not.toMatch(/11|2–11|2-11/);
  const html = view.container.innerHTML;
  expect(html.indexOf('Original agreed')).toBeLessThan(html.indexOf('Exact created outcome'));
  expect(html.indexOf('Exact created outcome')).toBeLessThan(html.indexOf('Original later'));
  expect(html.indexOf('Original earlier')).toBeLessThan(html.indexOf('Second independent outcome'));
  expect(html.indexOf('Second independent outcome')).toBeLessThan(html.indexOf('Original agreed'));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep original draft');
  view.unmount();
  render(<Surface />);
  expect(
    await screen.findByRole('link', { name: /Exact created outcome.*Created from this exchange/ }),
  ).toBeTruthy();
});
it('does not attach a matching ordinary creation to an aggregate transcript identity', async () => {
  setup();
  render(
    <Surface
      discoverTelosOrigins={false}
      inspected={{ ...request, status: 'ready', packet: packet() }}
    />,
  );
  await act(async () => {});
  expect(TelosWorkApiClient.prototype.links).not.toHaveBeenCalled();
  expect(TelosWorkApiClient.prototype.readSource).not.toHaveBeenCalled();
  expect(screen.queryByText('Created from this exchange')).toBeNull();
  expect(screen.getByText('Original agreed')).toBeTruthy();
});
it('uses the exact inspected creation once and does not override pending or unavailable source proof with ordinary discovery', async () => {
  setup();
  const view = render(<Surface inspected={{ ...request, status: 'ready', packet: packet() }} />);
  await screen.findByRole('link', { name: /Second independent outcome/ });
  expect(screen.getAllByRole('link', { name: /Exact created outcome/ })).toHaveLength(1);
  for (const status of ['loading', 'unavailable'] as const) {
    view.rerender(<Surface inspected={{ ...request, status }} />);
    expect(screen.queryByRole('link', { name: /Exact created outcome/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Second independent outcome/ })).toBeTruthy();
  }
});
it('refuses adoption, foreign identities, missing message/provenance and stale late replies after a chat switch', async () => {
  const read = setup();
  read.mockImplementation(
    async (itemId, snapshotId) =>
      ({
        available: true,
        snapshot: source(itemId, snapshotId),
        packet: { ...packet(), creation: undefined },
      }) as never,
  );
  const view = render(<Surface />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Created from this exchange')).toBeNull();
  read.mockImplementation(
    async (itemId, snapshotId) =>
      ({ available: true, snapshot: source('foreign', snapshotId), packet: packet() }) as never,
  );
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  expect(screen.queryByText('Created from this exchange')).toBeNull();
  for (const p of [
    packet('Absent boundary', 'missing'),
    { ...packet(), attributions: {} },
    {
      ...packet(),
      attributions: {
        agreed: { provenance: { seatId: 'foreign', membershipGeneration: 1, configRevision: 1 } },
      },
    },
  ]) {
    view.rerender(
      <Surface inspected={{ ...request, status: 'ready', packet: p as TelosSourcePacket }} />,
    );
    expect(screen.queryByText('Created from this exchange')).toBeNull();
  }
  let finish!: (value: never) => void;
  read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(6));
  view.rerender(<Surface sessionId="other" />);
  await act(async () =>
    finish({ available: true, snapshot: source('item-b', 'source-b'), packet: packet() } as never),
  );
  expect(screen.queryByText('Created from this exchange')).toBeNull();
});

it.each(['mounted', 'permission-resolved'] as const)(
  'discovers a confirmed source creation without remounting the ordinary chat (%s)',
  async (permissionState) => {
    setup();
    const links = vi.mocked(TelosWorkApiClient.prototype.links);
    links.mockResolvedValue([]);
    let releaseInitial!: (value: Awaited<ReturnType<TelosWorkApiClient['links']>>) => void;
    links.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInitial = resolve;
        }),
    );
    const permId = 'new-origin-permission';
    const proposalSha256 = 'a'.repeat(64);
    const expiresAt = Date.now() + 120_000;
    const review = {
      permId,
      sessionId: 'origin',
      toolUseId: 'create-once',
      expiresAt,
      proposalSha256,
      operation: {
        kind: 'create',
        outcome: {
          summary: 'Exact created outcome',
          intent: 'Retain source',
          rationale: 'Keep the original exchange',
          acceptanceCriteria: ['Exact source retained'],
          milestones: ['Read source'],
          profile: 'manual',
        },
      },
      source: {
        conversationId: 'origin',
        title: 'Original discussion',
        boundary: { sequence: 11, messageId: 'agreed' },
      },
      messages: [
        {
          messageId: 'agreed',
          sequence: 11,
          author: 'assistant',
          blocks: [
            { blockId: 'agreed', content: 'The agreed source text', sha256: 'c'.repeat(64) },
          ],
          attribution: null,
        },
      ],
      artifacts: [],
    };
    vi.spyOn(TelosWorkApiClient.prototype, 'getSourcePermission').mockResolvedValue(
      review as never,
    );
    vi.spyOn(TelosWorkApiClient.prototype, 'previewSourcePermission').mockImplementation(
      async (_id, input) =>
        ({
          permId,
          sessionId: 'origin',
          requestId: input.requestId,
          proposalSha256,
          preview: {
            sha256: 'b'.repeat(64),
            packet: {
              brief: { text: 'Reviewed original source' },
              context: {
                boundary: review.source.boundary,
                messages: review.messages,
                artifacts: [],
              },
            },
          },
        }) as never,
    );
    let releaseReceipt!: (
      value: Awaited<ReturnType<TelosWorkApiClient['approveSourcePermission']>>,
    ) => void;
    const approve = vi
      .spyOn(TelosWorkApiClient.prototype, 'approveSourcePermission')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseReceipt = resolve;
          }),
      );
    const receipt = {
      permId,
      sessionId: 'origin',
      receipt: { work: { itemId: 'item-a' } },
      sourceSnapshotId: 'source-a',
    } as never;
    const view = render(
      <Surface
        extra={
          <PermissionBanner
            permId={permId}
            sessionId="origin"
            reviewKind="telos_source"
            toolName="TelosCreateOutcome"
            toolInput="{}"
            expiresAt={expiresAt}
            onRespond={vi.fn()}
          />
        }
      />,
    );
    await waitFor(() => expect(links).toHaveBeenCalledTimes(1));
    const draft = screen.getByRole('textbox', { name: 'Unsent draft' });
    expect(screen.queryByText('Created from this exchange')).toBeNull();
    fireEvent.click(await screen.findByRole('checkbox', { name: /The agreed source text/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Review selected source' }));
    await screen.findByText('Reviewed source');
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    if (permissionState === 'permission-resolved') {
      // The real permission_resolved event removes only the banner before its
      // already-running approval HTTP request returns. Keep the chat mounted.
      view.rerender(<Surface />);
      expect(screen.queryByLabelText('Approval required')).toBeNull();
    }
    await act(async () => {
      links.mockResolvedValue([
        {
          itemId: 'item-a',
          role: 'origin',
          conversation: { namespace: 'mitzo', conversationId: 'origin' },
        },
      ] as never);
      releaseReceipt(receipt);
    });
    if (permissionState === 'mounted') await screen.findByText('Reviewed source saved.');
    expect(
      await screen.findByRole('link', {
        name: /Exact created outcome.*Created from this exchange/,
      }),
    ).toBeTruthy();
    await act(async () => releaseInitial([]));
    expect(
      screen.getByRole('link', { name: /Exact created outcome.*Created from this exchange/ }),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Unsent draft' })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe('Keep original draft');
  },
);
