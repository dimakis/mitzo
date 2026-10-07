// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionList } from '../SessionList';

const mocks = vi.hoisted(() => ({
  rename: vi.fn(),
  dismiss: vi.fn(),
  copy: vi.fn(async () => true),
}));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [{ id: 'one', summary: 'Review UI', lastModified: 30 }],
    quickActions: [],
    loading: false,
    hasMore: false,
    handleRename: mocks.rename,
    dismissSession: mocks.dismiss,
  }),
}));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ activities: [] }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({ active: false, query: '' }),
}));
vi.mock('../../lib/clipboard', () => ({ copyToClipboard: mocks.copy }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // jsdom does not implement native modal presentation.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          messageId: 'm1',
          role: 'assistant',
          blocks: [{ blockId: 'b1', blockType: 'text', content: 'The latest saved answer.' }],
        },
      ],
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <Routes>
        <Route path="/sessions" element={<SessionList />} />
        <Route path="/chat/:id" element={<p>Selected conversation</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByRole('link', { name: 'Open Review UI' });
}
function touch(row: Element, type: 'start' | 'move' | 'end' | 'cancel', x = 50, y = 50) {
  const init = { touches: [{ clientX: x, clientY: y }] };
  if (type === 'start') fireEvent.touchStart(row, init);
  if (type === 'move') fireEvent.touchMove(row, init);
  if (type === 'end') fireEvent.touchEnd(row);
  if (type === 'cancel') fireEvent.touchCancel(row);
}
async function hold(row: Element) {
  touch(row, 'start');
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
}
it('previews saved messages without opening the conversation or renaming on release', async () => {
  const row = mount();
  await hold(row);
  const preview = screen.getByRole('dialog', { name: 'Preview Review UI' });
  expect(within(preview).getByText('The latest saved answer.')).toBeTruthy();
  touch(row, 'end');
  fireEvent.click(row);
  expect(screen.queryByText('Selected conversation')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    '/api/sessions/one/messages',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.click(within(preview).getByRole('button', { name: 'Open conversation' }));
  expect(screen.getByText('Selected conversation')).toBeTruthy();
});
it.each(['move', 'cancel'] as const)('cancels a hold on touch %s', async (event) => {
  const row = mount();
  touch(row, 'start');
  touch(row, event, 50, 75);
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps ordinary taps opening a session and does not fetch a preview', () => {
  const row = mount();
  touch(row, 'start');
  touch(row, 'end');
  fireEvent.click(row);
  expect(screen.getByText('Selected conversation')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
it('supports context menus, cancel, focus restoration, and subsequent keyboard navigation', async () => {
  const row = mount();
  row.focus();
  fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
  await act(async () => {});
  const preview = screen.getByRole('dialog');
  fireEvent(preview, new Event('cancel', { bubbles: true, cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: 'Enter' });
  expect(screen.getByText('Selected conversation')).toBeTruthy();
});
it('returns Rename to the existing editor and saves through the existing action', async () => {
  const row = mount();
  await hold(row);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'New title' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.rename).toHaveBeenCalledWith('one', 'New title');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('copies the correct session ID with feedback and uses the existing delete action', async () => {
  const row = mount();
  await hold(row);
  const preview = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(preview).getByRole('button', { name: 'Copy session ID' }));
  });
  expect(mocks.copy).toHaveBeenCalledWith('one');
  expect(within(preview).getByText('Session ID copied')).toBeTruthy();
  fireEvent.click(within(preview).getByRole('button', { name: 'Delete conversation' }));
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith('one');
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('does not leave a pending hold after unmounting', async () => {
  const row = mount();
  touch(row, 'start');
  cleanup();
  await act(async () => {
    vi.advanceTimersByTime(600);
  });
  expect(fetch).not.toHaveBeenCalled();
});
it('opens a preview on desktop right click', async () => {
  const row = mount();
  fireEvent.contextMenu(row);
  await act(async () => {});
  expect(screen.getByRole('dialog', { name: 'Preview Review UI' })).toBeTruthy();
});

it.each(['Enter', ' '])(
  'keeps %s activation closing a revealed swipe action before navigating',
  (key) => {
    const row = mount();
    touch(row, 'start');
    touch(row, 'move', -50, 50);
    touch(row, 'end');
    fireEvent.keyDown(row, { key });
    expect(screen.queryByText('Selected conversation')).toBeNull();
    expect(row.closest<HTMLElement>('.session-item')?.style.transform).toBe('translateX(0px)');
    fireEvent.keyDown(row, { key });
    expect(screen.getByText('Selected conversation')).toBeTruthy();
  },
);

it('preserves the native context menu in the rename input', async () => {
  const row = mount();
  await hold(row);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename' }));
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('textbox'), event);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
});
