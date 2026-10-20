// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createTestStore } from '../../test-utils/createTestStore';
import { listChatDrafts } from '../../lib/chat-drafts';
import { TelosItemChatTab } from '../TelosItemChatTab';
import { eventBus } from '../../lib/event-bus-singleton';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
function view(roles = ['origin', 'worker', 'reviewer']) {
  return TelosWorkViewSchema.parse({
    itemId: 'slice',
    kind: 'work_item',
    parentId: 'goal',
    revision: 'a'.repeat(64),
    assignments: [],
    sources: [],
    attempts: [],
    links: roles.map((role) => ({
      version: 1,
      linkId: role,
      itemId: 'slice',
      role,
      conversation: { namespace: 'mitzo', conversationId: role },
      availability: 'available',
      linkedAt: null,
      linkedBy: null,
      attemptId: null,
    })),
  });
}
function Chat() {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output data-testid="chat-path">{location.pathname + location.search}</output>
      <button
        onClick={() => {
          const back = location.state.telosChatReturn;
          navigate(back.path, { state: back.state });
        }}
      >
        Back
      </button>
    </>
  );
}
function mount(work = view(), path = '/todos/slice?view=Chat') {
  vi.spyOn(TelosWorkApiClient.prototype, 'read').mockResolvedValue(work);
  const store = createTestStore();
  const newSession = vi.fn();
  store.setState({ newSession });
  render(
    <MitzoStoreProvider value={store}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/todos/:id"
            element={
              <TelosItemChatTab itemId="slice" title="Contributor controls" refreshKey={0} />
            }
          />
          <Route path="/chat/:sessionId" element={<Chat />} />
          <Route path="/chat" element={<output data-testid="setup">Setup</output>} />
        </Routes>
      </MemoryRouter>
    </MitzoStoreProvider>,
  );
  return { newSession };
}
it('adopts the multi-chat chooser and returns from an ordinary chat to the unselected list', async () => {
  const { newSession } = mount();
  await screen.findByRole('heading', { name: 'Chats · 3' });
  expect(screen.queryByTestId('chat-path')).toBeNull();
  expect(newSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open Worker conversation' }));
  expect((await screen.findByTestId('chat-path')).textContent).toBe(
    '/chat/worker?telosChatItem=slice',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByRole('heading', { name: 'Chats · 3' });
  expect(document.querySelector('[aria-current], [aria-selected="true"]')).toBeNull();
  expect(listChatDrafts()).toHaveLength(0);
});
it('directly enters one available ordinary non-origin conversation, with an explicit chooser return', async () => {
  mount(view(['worker']));
  expect((await screen.findByTestId('chat-path')).textContent).toBe(
    '/chat/worker?telosChatItem=slice',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByRole('heading', { name: 'Chats · 1' });
  expect(screen.queryByTestId('chat-path')).toBeNull();
});
it('refreshes a chooser without silently selecting a conversation when only one remains', async () => {
  mount();
  await screen.findByRole('heading', { name: 'Chats · 3' });
  vi.mocked(TelosWorkApiClient.prototype.read).mockResolvedValue(view(['worker']));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await screen.findByRole('heading', { name: 'Chats · 1' });
  expect(screen.queryByTestId('chat-path')).toBeNull();
});
it('refreshes current assignments on foreground SSE reconnect without a synthetic work event', async () => {
  let connection: (connected: boolean) => void = () => {};
  vi.spyOn(eventBus, 'onConnectionChange').mockImplementation((callback) => {
    connection = callback;
    return () => {};
  });
  mount();
  await screen.findByRole('heading', { name: 'Chats · 3' });
  vi.mocked(TelosWorkApiClient.prototype.read).mockResolvedValue(view(['worker']));
  act(() => {
    connection(false);
    connection(true);
  });
  await screen.findByRole('heading', { name: 'Chats · 1' });
  expect(screen.queryByTestId('chat-path')).toBeNull();
});
it('opens an external origin explicitly and retains distinct ordinary additional/replacement setup', async () => {
  const work = view(['origin']);
  work.assignments = [];
  work.links[0] = {
    ...work.links[0],
    role: 'origin',
    availability: 'unknown',
    conversation: {
      namespace: 'external_codex',
      conversationId: 'source',
      url: 'codex://threads/source',
    },
  };
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const { newSession } = mount(work);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Originating conversation' }));
  expect(open).toHaveBeenCalledWith('codex://threads/source', '_blank', 'noopener,noreferrer');
  expect(newSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await screen.findByTestId('setup');
  const draft = listChatDrafts()[0];
  const params = new URLSearchParams(draft.settings.search);
  expect(params.get('telosRoleItem')).toBe('slice');
  expect(params.get('telosRoleMode')).toBe('additional');
  expect(work.assignments).toEqual([]);
});
it.each([
  ['Choose lead collaborator', 'assign', false],
  ['New chat', 'additional', false],
  ['Change lead collaborator', 'assign', true],
  ['New chat', 'additional', true],
] as const)(
  'routes coordinator action %s with mode %s and current assignment %s',
  async (action, mode, assigned) => {
    const work = view(['origin', 'lead']);
    work.kind = 'coordinator';
    if (assigned)
      work.assignments = [
        {
          itemId: 'slice',
          role: 'lead',
          conversation: { namespace: 'mitzo', conversationId: 'lead' },
          revision: 3,
          assignedAt: null,
          assignedBy: null,
        },
      ];
    const before = structuredClone(work.assignments);
    const { newSession } = mount(work);
    await screen.findByRole('heading', { name: 'Chats · 2' });
    expect(newSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: action }));
    await screen.findByTestId('setup');
    const params = new URLSearchParams(listChatDrafts()[0].settings.search);
    expect(params.get('telosRoleItem')).toBe('slice');
    expect(params.get('telosRole')).toBe('lead');
    expect(params.get('telosRoleMode')).toBe(mode);
    expect(work.assignments).toEqual(before);
  },
);
