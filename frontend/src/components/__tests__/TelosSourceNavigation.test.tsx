// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosSourceNavigationProvider } from '../../hooks/TelosSourceNavigation';
import { TelosSourceWorkLink } from '../TelosSourceWorkLink';
import { ChatArea } from '../ChatArea';
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({ items: [{ id: 'item', summary: 'Home studio', children: [] }] }),
  findInTree: (items: unknown[]) => items[0],
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const request = { itemId: 'item', snapshotId: 'source', conversationId: 'origin' };
const view = {
  available: true,
  snapshot: {
    itemId: 'item',
    snapshotId: 'source',
    source: { namespace: 'mitzo', conversationId: 'origin' },
  },
  packet: {
    context: { sourceConversationId: 'origin', boundary: { messageId: 'approved', sequence: 2 } },
    attributions: { approved: { seatId: null, provenance: null, createdAt: 1 } },
  },
};
const messages = ['before', 'approved', 'after'].map((messageId) => ({
  messageId,
  role: 'user' as const,
  blocks: [{ blockId: messageId, blockType: 'text' as const, content: messageId }],
}));
function Surface({
  sessionId = 'origin',
  selected = request,
  history = messages,
  current = null,
  scrollRef,
}: {
  sessionId?: string;
  selected?: typeof request | null;
  history?: import('../../types/chat').FinishedMessage[];
  current?: import('../../types/chat').StreamingMessage | null;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <MemoryRouter>
      <TelosSourceNavigationProvider request={selected ?? undefined} sessionId={sessionId}>
        <TelosSourceWorkLink />
        <ChatArea
          sessionId={sessionId}
          messages={history}
          current={current}
          scrollRef={scrollRef}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
      </TelosSourceNavigationProvider>
    </MemoryRouter>
  );
}
it('opens the real retained boundary once, links to the item and preserves later conversation history', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue(view as never);
  const jump = vi.fn();
  Element.prototype.scrollIntoView = jump;
  const bottom = vi.fn();
  Element.prototype.scrollTo = bottom;
  const surface = render(<Surface />);
  await screen.findByRole('link', { name: 'Home studio' });
  await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
  expect((jump.mock.contexts[0] as HTMLElement).textContent).toContain('approved');
  expect(screen.getByText('after')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Home studio' }).getAttribute('href')).toBe(
    '/todos/item',
  );
  expect(bottom).not.toHaveBeenCalled();
  surface.rerender(<Surface />);
  expect(jump).toHaveBeenCalledTimes(1);
});
it.each(['', ' \n\t'])(
  'anchors the first visible assistant text after an invisible block %j',
  async (hidden) => {
    vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue(view as never);
    const jump = vi.fn();
    Element.prototype.scrollIntoView = jump;
    Element.prototype.scrollTo = vi.fn();
    const surface = render(
      <Surface
        history={[
          {
            messageId: 'approved',
            role: 'assistant',
            blocks: [
              { blockId: 'empty', blockType: 'text', content: hidden },
              { blockId: 'visible', blockType: 'text', content: 'Visible approved plan' },
              { blockId: 'later', blockType: 'text', content: 'Later public detail' },
            ],
          },
        ]}
      />,
    );
    await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
    const anchors = surface.container.querySelectorAll('[data-telos-source-anchor="true"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].textContent).toContain('Visible approved plan');
    expect(anchors[0].textContent).not.toContain('Later public detail');
  },
);

it.each(
  [[], [''], [' \n\t']].flatMap((contents) =>
    (['source-first', 'history-first'] as const).map((order) => ({ contents, order })),
  ),
)(
  'releases a restored blank assistant boundary ($contents, $order)',
  async ({ contents, order }) => {
    let resolve!: (value: never) => void;
    const read = vi
      .spyOn(TelosWorkApiClient.prototype, 'readSource')
      .mockImplementation(() => new Promise((finish) => (resolve = finish)));
    const jump = vi.fn();
    Element.prototype.scrollIntoView = jump;
    Element.prototype.scrollTo = vi.fn();
    const scrollRef = { current: null as HTMLDivElement | null };
    const history: import('../../types/chat').FinishedMessage[] = messages.map((message) =>
      message.messageId === 'approved'
        ? {
            ...message,
            role: 'assistant' as const,
            blocks: contents.map((content, index) => ({
              blockId: `blank-${index}`,
              blockType: 'text' as const,
              content,
            })),
          }
        : message,
    );
    const stream = (content: string): import('../../types/chat').StreamingMessage => ({
      messageId: 'reply',
      blocks: new Map([
        ['reply-text', { blockId: 'reply-text', blockType: 'text', content, done: false }],
      ]),
      blockOrder: ['reply-text'],
    });
    const surface = render(<Surface scrollRef={scrollRef} history={[]} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const el = scrollRef.current!;
    let height = 2_000;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, value: 500 },
    });
    if (order === 'history-first') {
      surface.rerender(<Surface scrollRef={scrollRef} history={history} />);
      expect(el.scrollTop).toBe(0);
    }
    await act(async () => resolve(view as never));
    if (order === 'source-first') {
      // A source response alone cannot establish whether its transcript row exists.
      expect(el.scrollTop).toBe(0);
      surface.rerender(<Surface scrollRef={scrollRef} history={history} />);
    }
    expect(el.scrollTop).toBe(height);
    expect(jump).not.toHaveBeenCalled();
    expect(surface.container.querySelector('[data-telos-source-anchor="true"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Home studio' })).toBeTruthy();

    el.scrollTop = 300;
    fireEvent.scroll(el);
    height = 2_500;
    surface.rerender(
      <Surface scrollRef={scrollRef} history={history} current={stream('First later reply')} />,
    );
    expect(el.scrollTop).toBe(300);
    el.scrollTop = height - el.clientHeight;
    fireEvent.scroll(el);
    height = 3_000;
    surface.rerender(
      <Surface scrollRef={scrollRef} history={history} current={stream('A longer later reply')} />,
    );
    expect(el.scrollTop).toBe(height);
    expect(jump).not.toHaveBeenCalled();
  },
);

it.each(['tool-only', 'activity-only', 'later-visible-text'] as const)(
  'preserves assistant activity and only owns a position with visible public text (%s)',
  async (kind) => {
    vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue(view as never);
    const jump = vi.fn();
    Element.prototype.scrollIntoView = jump;
    Element.prototype.scrollTo = vi.fn();
    const scrollRef = { current: null as HTMLDivElement | null };
    const surface = render(<Surface scrollRef={scrollRef} history={[]} />);
    await screen.findByRole('link', { name: 'Home studio' });
    const el = scrollRef.current!;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    const history: import('../../types/chat').FinishedMessage[] = [
      {
        messageId: 'approved',
        role: 'assistant',
        blocks: [
          ...(kind === 'tool-only'
            ? []
            : [{ blockId: 'blank', blockType: 'text' as const, content: ' \n\t' }]),
          {
            blockId: 'tool',
            blockType: 'tool_use',
            content: '',
            toolName: 'Read',
            toolInput: '{}',
          },
          ...(kind === 'later-visible-text'
            ? [{ blockId: 'visible', blockType: 'text' as const, content: 'Reviewed plan' }]
            : []),
        ],
      },
    ];
    surface.rerender(<Surface scrollRef={scrollRef} history={history} />);
    expect(screen.getByRole('button', { name: /Agents at work/ })).toBeTruthy();
    if (kind === 'later-visible-text') {
      expect(el.scrollTop).toBe(0);
      await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
      expect((jump.mock.contexts[0] as HTMLElement).textContent).toContain('Reviewed plan');
    } else {
      expect(el.scrollTop).toBe(2_000);
      expect(jump).not.toHaveBeenCalled();
      el.scrollTop = 300;
      fireEvent.scroll(el);
      surface.rerender(
        <Surface
          scrollRef={scrollRef}
          history={[
            ...history,
            {
              messageId: 'later',
              role: 'assistant',
              blocks: [{ blockId: 'later-text', blockType: 'text', content: 'Later reply' }],
            },
          ]}
        />,
      );
      expect(el.scrollTop).toBe(300);
      expect(screen.getByRole('button', { name: /Agents at work/ })).toBeTruthy();
    }
  },
);

it('releases a failed source lookup for restore and following after returning to the bottom', async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(
    () => new Promise((_resolve, fail) => (reject = fail)),
  );
  const jump = vi.fn();
  Element.prototype.scrollIntoView = jump;
  Element.prototype.scrollTo = vi.fn();
  const scrollRef = { current: null as HTMLDivElement | null };
  const stream = (content: string): import('../../types/chat').StreamingMessage => ({
    messageId: 'reply',
    blocks: new Map([
      ['reply-text', { blockId: 'reply-text', blockType: 'text', content, done: false }],
    ]),
    blockOrder: ['reply-text'],
  });
  const surface = render(<Surface scrollRef={scrollRef} history={[]} />);
  const el = scrollRef.current!;
  let height = 2_000;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 500 },
  });
  el.scrollTop = 0;
  await waitFor(() => expect(reject).toBeTypeOf('function'));
  surface.rerender(<Surface scrollRef={scrollRef} />);
  expect(screen.getByText('after')).toBeTruthy();
  expect(el.scrollTop).toBe(0);
  await act(async () => reject(Error('Retained source unavailable')));
  await screen.findByText('Original exchange unavailable');
  expect(el.scrollTop).toBe(height);
  expect(jump).not.toHaveBeenCalled();

  el.scrollTop = 600;
  fireEvent.scroll(el);
  height = 2_400;
  surface.rerender(<Surface scrollRef={scrollRef} current={stream('First reply')} />);
  expect(el.scrollTop).toBe(600);
  el.scrollTop = height - el.clientHeight;
  fireEvent.scroll(el);
  height = 3_000;
  surface.rerender(<Surface scrollRef={scrollRef} current={stream('A longer reply')} />);
  expect(el.scrollTop).toBe(height);
  expect(jump).not.toHaveBeenCalled();
});

it('keeps a newer source lookup fenced when an older lookup fails after transcript restore', async () => {
  const pending: { resolve(value: typeof view): void; reject(error: Error): void }[] = [];
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(
    () =>
      new Promise((resolve, reject) =>
        pending.push({
          resolve: (value) => resolve(value as never),
          reject,
        }),
      ),
  );
  const jump = vi.fn();
  Element.prototype.scrollIntoView = jump;
  Element.prototype.scrollTo = vi.fn();
  const scrollRef = { current: null as HTMLDivElement | null };
  const newer = { ...request, snapshotId: 'newer-source' };
  const surface = render(<Surface history={[]} scrollRef={scrollRef} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  const el = scrollRef.current!;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 2_000 },
    clientHeight: { configurable: true, value: 500 },
  });
  surface.rerender(<Surface selected={newer} scrollRef={scrollRef} />);
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[0].reject(Error('Old source failed late')));
  expect(read.mock.calls[0][2]?.aborted).toBe(true);
  expect(read.mock.calls[1][2]?.aborted).toBe(false);
  expect(screen.queryByText('Original exchange unavailable')).toBeNull();
  expect(el.scrollTop).toBe(0);
  expect(jump).not.toHaveBeenCalled();
  await act(async () =>
    pending[1].resolve({
      ...view,
      snapshot: { ...view.snapshot, snapshotId: newer.snapshotId },
    }),
  );
  await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
  el.scrollTop = 300;
  fireEvent.scroll(el);
  surface.rerender(
    <Surface
      selected={newer}
      scrollRef={scrollRef}
      history={[
        ...messages,
        {
          messageId: 'new-reply',
          role: 'assistant',
          blocks: [{ blockId: 'reply', blockType: 'text', content: 'A later reply' }],
        },
      ]}
    />,
  );
  expect(el.scrollTop).toBe(300);
  expect(jump).toHaveBeenCalledTimes(1);
});

it('cancels an ordinary restore frame when a newer source lookup takes ownership', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id));
  let resolve!: (value: never) => void;
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'readSource')
    .mockImplementation(() => new Promise((finish) => (resolve = finish)));
  const bottom = vi.fn();
  Element.prototype.scrollTo = bottom;
  const jump = vi.fn();
  Element.prototype.scrollIntoView = jump;
  const surface = render(<Surface selected={null} history={[]} />);
  surface.rerender(<Surface selected={null} />);
  expect(frames.size).toBeGreaterThan(0);
  surface.rerender(<Surface />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  for (const callback of frames.values()) callback(0);
  expect(bottom).not.toHaveBeenCalled();
  await act(async () => resolve(view as never));
  await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
  expect(bottom).not.toHaveBeenCalled();
});

it.each(['initial', 'settling'] as const)(
  'respects a scroll-away before the %s source release frame',
  async (phase) => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      frames.push(callback),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(
      () => new Promise((_resolve, fail) => (reject = fail)),
    );
    const bottom = vi.fn();
    Element.prototype.scrollTo = bottom;
    Element.prototype.scrollIntoView = vi.fn();
    const scrollRef = { current: null as HTMLDivElement | null };
    const surface = render(<Surface scrollRef={scrollRef} history={[]} />);
    const el = scrollRef.current!;
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    await waitFor(() => expect(reject).toBeTypeOf('function'));
    surface.rerender(<Surface scrollRef={scrollRef} />);
    await act(async () => reject(Error('Source unavailable')));
    expect(frames.length).toBeGreaterThan(0);
    if (phase === 'settling') {
      frames.shift()!(0);
      bottom.mockClear();
    }
    el.scrollTop = 300;
    fireEvent.scroll(el);
    for (const frame of frames) frame(0);
    expect(bottom).not.toHaveBeenCalled();
    expect(el.scrollTop).toBe(300);
  },
);
it('fences a late source response when moving to another chat', async () => {
  let finish!: (value: never) => void;
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  const surface = render(<Surface />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  surface.rerender(<Surface sessionId="other" />);
  await act(async () => finish(view as never));
  expect(screen.queryByRole('link', { name: 'Home studio' })).toBeNull();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(read.mock.calls[0][2]?.aborted).toBe(true);
});
it('does not claim a source or move the transcript when its recorded conversation differs', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue({
    ...view,
    packet: { ...view.packet, context: { ...view.packet.context, sourceConversationId: 'other' } },
  } as never);
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  render(<Surface />);
  await screen.findByText('Original exchange unavailable');
  expect(screen.queryByRole('link', { name: 'Home studio' })).toBeNull();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it('keeps the ordinary chat usable when an invalid source selector fails synchronously', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockImplementation(() => {
    throw Error('Invalid source selector');
  });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  render(<Surface selected={{ ...request, itemId: ' ' }} />);
  await screen.findByText('Original exchange unavailable');
  expect(screen.getByText('after')).toBeTruthy();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it('anchors the recorded native seat and generation within the full shared transcript', async () => {
  const provenance = (seatId: string) => ({
    seatId,
    membershipGeneration: 2,
    configRevision: 3,
    accountProfileRevision: 'a',
    seatProfileRevision: 'p',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'shared',
    isolationDomainRevision: 1,
  });
  const builder = provenance('builder');
  vi.spyOn(TelosWorkApiClient.prototype, 'readSource').mockResolvedValue({
    ...view,
    packet: {
      ...view.packet,
      attributions: { approved: { seatId: 'builder', provenance: builder, createdAt: 1 } },
    },
  } as never);
  const jump = vi.fn();
  Element.prototype.scrollIntoView = jump;
  Element.prototype.scrollTo = vi.fn();
  render(
    <Surface
      history={['builder', 'reviewer'].map((seat) => ({
        messageId: 'approved',
        role: 'assistant',
        symposiumProvenance: provenance(seat),
        blocks: [{ blockId: seat, blockType: 'text', content: seat + ' public plan' }],
      }))}
    />,
  );
  await waitFor(() => expect(jump).toHaveBeenCalledTimes(1));
  expect((jump.mock.contexts[0] as HTMLElement).textContent).toContain('builder public plan');
  expect(screen.getByText('reviewer public plan')).toBeTruthy();
});
