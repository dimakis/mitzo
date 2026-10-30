// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TelosWorkApiClient } from '@mitzo/client';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosTreeConversationEntry } from '../TelosTreeConversationEntry';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const fixture = createTelosWorkFixtures().leadWithUnstartedSlice;
const item = fixture.items[0];
const view = {
  itemId: item.itemId,
  kind: item.kind,
  parentId: item.parentId,
  revision: 'f'.repeat(64),
  links: fixture.links.filter((l) => l.itemId === item.itemId),
  assignments: fixture.assignments.filter((a) => a.itemId === item.itemId),
  sources: [],
  attempts: [],
};
it('opens the workspace Chat entry for an authoritative current lead without allocating', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue(view);
  const open = vi.fn();
  render(<TelosTreeConversationEntry refreshKey={0} itemId={item.itemId} onOpenChat={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Lead chat' }));
  expect(open).toHaveBeenCalledOnce();
});
it('does not turn an originating conversation into a lead assignment', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    ...view,
    assignments: [],
    links: fixture.links.filter((l) => l.role === 'origin'),
  });
  render(<TelosTreeConversationEntry refreshKey={0} itemId={item.itemId} onOpenChat={vi.fn()} />);
  expect(await screen.findByText('No lead assigned')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose lead' })).toBeTruthy();
});
it('keeps failed relationship reads distinct from no assignment', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockRejectedValue(Error('unavailable'));
  render(<TelosTreeConversationEntry refreshKey={0} itemId={item.itemId} onOpenChat={vi.fn()} />);
  expect(await screen.findByText('Conversations unavailable')).toBeTruthy();
  expect(screen.queryByText('No lead assigned')).toBeNull();
});
it('reads a coordinator current assignment from the retained lead role while preserving its display kind', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    ...view,
    kind: 'coordinator',
  });
  const open = vi.fn();
  render(<TelosTreeConversationEntry refreshKey={0} itemId={item.itemId} onOpenChat={open} />);
  expect(await screen.findByText('Coordinator assigned')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Coordinator chat' }));
  expect(open).toHaveBeenCalledOnce();
});
it('does not treat an additional coordinator lead link as a current control assignment', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    ...view,
    kind: 'coordinator',
    assignments: [],
  });
  render(<TelosTreeConversationEntry refreshKey={0} itemId={item.itemId} onOpenChat={vi.fn()} />);
  expect(await screen.findByText('No coordinator assigned')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'View coordinator' })).toBeTruthy();
  expect(screen.queryByText('Coordinator assigned')).toBeNull();
});

it('uses a chat entry for a canonically unclassified row without making a relationship read to infer its role', async () => {
  const read = vi.spyOn(TelosWorkApiClient.prototype, 'read');
  const open = vi.fn();
  render(
    <TelosTreeConversationEntry itemId="new-report" kind={null} refreshKey={0} onOpenChat={open} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open chats' }));
  expect(open).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});
