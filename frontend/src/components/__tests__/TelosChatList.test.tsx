// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TelosWorkViewSchema, type TelosWorkView } from '@mitzo/protocol';
import { TelosChatList } from '../TelosChatList';
import { telosChatRows, telosDirectChat } from '../../lib/telos-chat-rows';

afterEach(cleanup);
function work(): TelosWorkView {
  return TelosWorkViewSchema.parse({
    itemId: 'slice',
    kind: 'work_item',
    parentId: 'goal',
    revision: 'a'.repeat(64),
    assignments: [
      {
        itemId: 'slice',
        role: 'worker',
        conversation: { namespace: 'mitzo', conversationId: 'worker' },
        revision: 2,
        assignedAt: '2026-10-18',
        assignedBy: 'Dimitri',
      },
    ],
    links: ['origin', 'worker', 'reviewer'].map((role) => ({
      version: 1,
      linkId: role,
      itemId: 'slice',
      role,
      conversation: { namespace: 'mitzo', conversationId: role },
      linkedAt: '2026-10-18',
      linkedBy: 'Dimitri',
      availability: 'available',
      attemptId: null,
    })),
    sources: [],
    attempts: [],
  });
}
describe('approved S8 conversation selection', () => {
  it('lists every unique conversation first with no preselection or navigation', () => {
    const onOpen = vi.fn(),
      onNewChat = vi.fn(),
      onChangeWorker = vi.fn();
    const view = work();
    render(
      <TelosChatList
        work={view}
        title="Contributor controls"
        onOpen={onOpen}
        onNewChat={onNewChat}
        onChangeAssignment={onChangeWorker}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Chats · 3' })).toBeTruthy();
    expect(screen.getByText('Assigned worker')).toBeTruthy();
    expect(screen.getByText('Originating conversation')).toBeTruthy();
    expect(screen.getByText('Reviewer')).toBeTruthy();
    expect(document.querySelector('[aria-current], [aria-selected="true"]')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(telosDirectChat(view)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open Reviewer/ }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { namespace: 'mitzo', conversationId: 'reviewer' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(onChangeWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change worker' }));
    expect(onChangeWorker).toHaveBeenCalledOnce();
    expect(view.assignments[0].conversation.conversationId).toBe('worker');
  });
  it('deduplicates role links and source snapshots by namespace and conversation', () => {
    const view = work();
    view.links.push({
      ...view.links[1],
      linkId: 'worker-advisor',
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'worker' },
    });
    view.sources.push({
      version: 1,
      snapshotId: 'source',
      itemId: 'slice',
      source: view.links[0].conversation,
      selection: { kind: 'selected', messageIds: ['message'], blockIds: [], throughSequence: 2 },
      adoptedBrief: null,
      artifacts: [],
      author: 'Dimitri',
      sourceCreatedAt: null,
      adoptedAt: null,
    });
    expect(telosChatRows(view)).toHaveLength(3);
    expect(telosChatRows(view)[1].labels).toEqual(['Assigned worker', 'Advisor']);
    expect(telosChatRows(view)[0].sources[0].snapshotId).toBe('source');
  });
  it('allows one available ordinary non-origin chat to enter directly; source-only remains unassigned', () => {
    const view = work();
    view.links = [view.links[1]];
    expect(telosDirectChat(view)?.conversation.conversationId).toBe('worker');
    view.links = [{ ...view.links[0], role: 'origin' }];
    view.assignments = [];
    expect(telosDirectChat(view)).toBeNull();
    render(
      <TelosChatList
        work={view}
        title="Home studio"
        onOpen={vi.fn()}
        onNewChat={vi.fn()}
        onChangeAssignment={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Choose worker' })).toBeTruthy();
    expect(screen.queryByText('Assigned worker')).toBeNull();
  });
  it('keeps unavailable chats and historical roles visible after assignment replacement', () => {
    const view = work();
    view.assignments[0].conversation.conversationId = 'replacement';
    view.links[1].availability = 'unavailable';
    render(
      <TelosChatList
        work={view}
        title="Slice"
        onOpen={vi.fn()}
        onNewChat={vi.fn()}
        onChangeAssignment={vi.fn()}
      />,
    );
    const row = screen.getByRole('button', { name: /Open Worker conversation/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByText('Unavailable')).toBeTruthy();
    expect(screen.queryByText('Assigned worker')).toBeNull();
    expect(screen.queryByText(/Completed|Running/)).toBeNull();
  });
  it('does not silently promote an unknown or external origin into an ordinary chat', () => {
    const view = work();
    view.links = [
      {
        ...view.links[0],
        role: 'origin',
        availability: 'unknown',
        conversation: {
          namespace: 'external_codex',
          conversationId: 'worker',
          url: 'codex://threads/worker',
        },
      },
    ];
    expect(telosDirectChat(view)).toBeNull();
    expect(telosChatRows(view)[0].labels).toEqual(['Originating conversation']);
  });
});
