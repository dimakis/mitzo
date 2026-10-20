// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { TelosChatList } from '../TelosChatList';
import { telosChatRows, telosDirectChat } from '../../lib/telos-chat-rows';

afterEach(cleanup);
function fixture(role: 'lead' | 'worker' = 'lead') {
  const view = TelosWorkViewSchema.parse({
    itemId: 'item',
    kind: role === 'lead' ? 'outcome' : 'work_item',
    parentId: null,
    revision: 'a'.repeat(64),
    sources: [],
    attempts: [],
    links: ['former', 'additional', 'current'].map((conversationId) => ({
      version: 1,
      linkId: conversationId,
      itemId: 'item',
      role,
      conversation: { namespace: 'mitzo', conversationId },
      linkedAt: null,
      linkedBy: null,
      availability: 'available',
      attemptId: null,
    })),
    assignments: [
      {
        itemId: 'item',
        role,
        conversation: { namespace: 'mitzo', conversationId: 'current' },
        revision: 2,
        assignedAt: null,
        assignedBy: null,
      },
    ],
    assignmentHistory: {
      lead: { complete: true, conversationIds: role === 'lead' ? ['former', 'current'] : [] },
      worker: { complete: true, conversationIds: role === 'worker' ? ['former', 'current'] : [] },
    },
  });
  if (!view.assignmentHistory) throw new Error('Protocol must retain supplied assignment history');
  return { ...view, assignmentHistory: view.assignmentHistory };
}
it.each(['lead', 'worker'] as const)(
  'uses authoritative current, proven previous and complete additional %s history',
  (role) => {
    const view = fixture(role);
    const before = structuredClone(view);
    const labels = () =>
      Object.fromEntries(
        telosChatRows(view).map((row) => [row.conversation.conversationId, row.labels]),
      );
    expect(labels()).toEqual({
      former: ['Previous conversation'],
      additional: [role === 'lead' ? 'Additional lead conversation' : 'Additional worker'],
      current: [`Assigned ${role}`],
    });
    expect(view).toEqual(before);
    view.links.reverse();
    expect(labels()).toEqual({
      former: ['Previous conversation'],
      additional: [role === 'lead' ? 'Additional lead conversation' : 'Additional worker'],
      current: [`Assigned ${role}`],
    });
    expect(telosDirectChat(view)).toBeNull();
  },
);
it('keeps the additional Independent reviewer profile as a lead role in visible and accessible labels', () => {
  const view = fixture();
  const row = telosChatRows(view).find((row) => row.conversation.conversationId === 'additional')!;
  render(
    <TelosChatList
      work={view}
      title="Outcome"
      details={{ [row.key]: { title: 'Independent reviewer' } }}
      onOpen={vi.fn()}
      onNewChat={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Open Additional lead conversation: Independent reviewer' }),
  ).toBeTruthy();
  expect(screen.getByText('Previous conversation')).toBeTruthy();
  expect(screen.getByText('Assigned lead')).toBeTruthy();
  expect(screen.queryByText('Reviewer', { exact: true })).toBeNull();
  expect(
    screen.getByText(
      /New chat keeps the assigned lead collaborator; Change lead collaborator assigns a replacement\./,
    ),
  ).toBeTruthy();
  expect(view.links.every((link) => link.role === 'lead')).toBe(true);
});
it.each([false, true])(
  'keeps incomplete or absent history honest while preserving current authority, absent=%s',
  (absent) => {
    const view = fixture();
    view.assignmentHistory.lead.complete = false;
    if (absent) delete (view as Partial<typeof view>).assignmentHistory;
    render(<TelosChatList work={view} title="Outcome" onOpen={vi.fn()} onNewChat={vi.fn()} />);
    const rows = screen.getAllByRole('button', { name: 'Open Lead conversation' });
    expect(rows).toHaveLength(absent ? 2 : 1);
    const row = rows[0];
    expect(row.getAttribute('aria-description')).toBe('Lead assignment history unknown');
    expect(screen.getAllByText('Lead assignment history unknown').length).toBe(absent ? 2 : 1);
    expect(screen.getByText('Assigned lead')).toBeTruthy();
    if (!absent) expect(screen.getByText('Previous conversation')).toBeTruthy();
    expect(screen.queryByText('Additional lead conversation')).toBeNull();
  },
);
it('does not borrow a Mitzo historical identity for an external conversation with the same id', () => {
  const view = fixture();
  view.links[0].conversation = {
    namespace: 'external_codex',
    conversationId: 'former',
    url: 'codex://threads/former',
  };
  expect(telosChatRows(view)[0].labels).toEqual(['Additional lead conversation']);
  expect(view.assignments[0].conversation.conversationId).toBe('current');
});
it('does not fabricate a previous assignment from a link when complete history is empty', () => {
  const view = fixture('worker');
  view.assignments = [];
  view.assignmentHistory.worker.conversationIds = [];
  expect(telosChatRows(view).every((row) => row.labels[0] === 'Additional worker')).toBe(true);
  expect(view.assignments).toEqual([]);
});
