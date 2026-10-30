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
function fixture(kind: 'outcome' | 'work_item' | 'coordinator' | null, links: unknown[] = []) {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue(
    TelosWorkViewSchema.parse({
      itemId: 'selected',
      kind,
      parentId: kind === 'work_item' ? 'goal' : null,
      revision: 'a'.repeat(64),
      links,
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
it('offers an explicit ordinary lead assignment for a coordinator without turning New chat into authority', async () => {
  const f = fixture('coordinator');
  fireEvent.click(await screen.findByRole('button', { name: 'Choose lead collaborator' }));
  const location = new URL(screen.getByTestId('location').textContent!, 'https://offline.test');
  expect(location.searchParams.get('telosRole')).toBe('lead');
  expect(location.searchParams.get('telosRoleMode')).toBe('assign');
  expect(f.newSession).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});
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

it('offers a separate ordinary chat for unclassified backlog work without claiming a session exists', async () => {
  const f = fixture(null);
  expect(await screen.findByText('No dedicated conversation yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  const location = new URL(screen.getByTestId('location').textContent!, 'https://fixture.test');
  expect(location.pathname).toBe('/chat');
  expect(location.searchParams.get('telosRoleItem')).toBe('selected');
  expect(location.searchParams.get('telosRoleMode')).toBe('additional');
  expect(f.newSession).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});

it('does not call a second role on the originating chat a separate conversation', async () => {
  const link = {
    version: 1,
    itemId: 'selected',
    conversation: { namespace: 'mitzo', conversationId: 'same-chat' },
    linkedAt: '2026-10-30T10:00:00Z',
    linkedBy: 'operator:fixture',
    availability: 'available',
    attemptId: null,
  };
  fixture(null, [
    { ...link, linkId: 'origin', role: 'origin' },
    { ...link, linkId: 'advisor', role: 'advisor' },
  ]);
  expect(await screen.findByText('No dedicated conversation yet.')).toBeTruthy();
  expect(screen.queryByText('Separate conversations are linked to this item.')).toBeNull();
});
