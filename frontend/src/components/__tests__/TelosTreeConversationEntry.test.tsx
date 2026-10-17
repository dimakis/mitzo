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
  render(<TelosTreeConversationEntry itemId={item.itemId} onOpenChat={open} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Lead chat' }));
  expect(open).toHaveBeenCalledOnce();
});
it('does not turn an originating conversation into a lead assignment', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue({
    ...view,
    assignments: [],
    links: fixture.links.filter((l) => l.role === 'origin'),
  });
  render(<TelosTreeConversationEntry itemId={item.itemId} onOpenChat={vi.fn()} />);
  expect(await screen.findByText('No lead assigned')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose lead' })).toBeTruthy();
});
it('keeps failed relationship reads distinct from no assignment', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockRejectedValue(Error('unavailable'));
  render(<TelosTreeConversationEntry itemId={item.itemId} onOpenChat={vi.fn()} />);
  expect(await screen.findByText('Conversations unavailable')).toBeTruthy();
  expect(screen.queryByText('No lead assigned')).toBeNull();
});
