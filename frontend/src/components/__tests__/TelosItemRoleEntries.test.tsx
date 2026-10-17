// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { createTestStore } from '../../test-utils/createTestStore';
import { listChatDrafts } from '../../lib/chat-drafts';
import { TelosItemRoleEntries } from '../TelosItemRoleEntries';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function fixture(kind: 'outcome' | 'work_item') {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue(
    TelosWorkViewSchema.parse({
      itemId: 'selected',
      kind,
      parentId: kind === 'work_item' ? 'goal' : null,
      revision: 'a'.repeat(64),
      links: [],
      assignments: [],
      sources: [],
      attempts: [],
    }),
  );
  const store = createTestStore();
  const newSession = vi.fn(),
    send = vi.fn();
  store.setState({ newSession, sendMessage: send });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={['/todos/selected']}>
        <Location />
        <TelosItemRoleEntries itemId="selected" />
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return { newSession, send };
}
it('keeps leaf work item refinement but exposes no unsupported child creation entry', async () => {
  const f = fixture('work_item');
  const refine = await screen.findByRole('button', { name: 'Refine item' });
  expect(screen.getByRole('button', { name: 'Choose worker' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add child with advisor' })).toBeNull();
  expect(listChatDrafts()).toHaveLength(0);
  expect(f.newSession).not.toHaveBeenCalled();
  fireEvent.click(refine);
  const location = new URL(screen.getByTestId('location').textContent!, 'https://offline.test');
  expect(location.pathname).toBe('/chat');
  expect(location.searchParams.get('telosAdvisor')).toBe('refine');
  expect(location.searchParams.get('telosRoleItem')).toBe('selected');
  expect(listChatDrafts()).toHaveLength(1);
  expect(f.newSession).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});
it('offers child advisor setup for an explicitly typed outcome with no existing children', async () => {
  const f = fixture('outcome');
  fireEvent.click(await screen.findByRole('button', { name: 'Add child with advisor' }));
  const location = new URL(screen.getByTestId('location').textContent!, 'https://offline.test');
  expect(location.searchParams.get('telosAdvisor')).toBe('child');
  expect(location.searchParams.get('telosRole')).toBe('advisor');
  expect(location.searchParams.get('telosRoleMode')).toBe('additional');
  expect(f.newSession).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});
