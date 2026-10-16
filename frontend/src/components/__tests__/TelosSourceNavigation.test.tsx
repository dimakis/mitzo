// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
}: {
  sessionId?: string;
  selected?: typeof request;
  history?: import('../../types/chat').FinishedMessage[];
}) {
  return (
    <MemoryRouter>
      <TelosSourceNavigationProvider request={selected} sessionId={sessionId}>
        <TelosSourceWorkLink />
        <ChatArea
          sessionId={sessionId}
          messages={history}
          current={null}
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
