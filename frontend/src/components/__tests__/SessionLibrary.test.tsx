// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationPins } from '../ConversationPins';
import { ResizableSessionLayout } from '../ResizableSessionLayout';
import { SessionInspector } from '../SessionInspector';
const sessions = Array.from({ length: 6 }, (_, i) => ({
  id: String(i),
  summary: `Conversation ${i}`,
  lastModified: i,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it('collapses the pinned group and restores that choice without deleting pins', () => {
  localStorage.setItem('mitzo-conversation-pins', JSON.stringify(sessions));
  render(<ConversationPins sessions={sessions} onSelect={vi.fn()} onActions={vi.fn()} />);
  expect(
    screen
      .getByRole('region', { name: 'Pinned conversations' })
      .querySelectorAll('.conversation-pin-row'),
  ).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: /Collapse pinned/ }));
  expect(screen.queryByRole('region', { name: 'Pinned conversations' })).toBeNull();
  expect(JSON.parse(localStorage.getItem('mitzo-conversation-pins')!)).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: /Expand pinned/ }));
  expect(screen.getByRole('region', { name: 'Pinned conversations' })).toBeTruthy();
});
it('resizes the preview by keyboard and retains the clamped width', () => {
  render(
    <ResizableSessionLayout preview={<p>Preview</p>}>
      <p>Conversations</p>
    </ResizableSessionLayout>,
  );
  const divider = screen.getByRole('separator', { name: 'Resize conversation preview' });
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider.getAttribute('aria-valuenow')).toBe('38');
  fireEvent.keyDown(divider, { key: 'End' });
  expect(divider.getAttribute('aria-valuenow')).toBe('52');
  expect(localStorage.getItem('mitzo-session-preview-width')).toBe('52');
});
it('aborts a stale preview request on selection changes and never resumes a provider', async () => {
  let resolveFirst!: (value: unknown) => void;
  const fetcher = vi.fn((url: string) =>
    url.includes('/0/')
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve({
          ok: true,
          json: async () => [
            {
              messageId: 'two',
              role: 'assistant',
              blocks: [{ blockType: 'text', content: 'Second session answer' }],
            },
          ],
        }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <MemoryRouter>
      <SessionInspector session={sessions[0]} onOpen={vi.fn()} onActions={vi.fn()} />
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter>
      <SessionInspector session={sessions[1]} onOpen={vi.fn()} onActions={vi.fn()} />
    </MemoryRouter>,
  );
  await act(async () => {});
  expect(screen.getByText('Second session answer')).toBeTruthy();
  await act(async () => {
    resolveFirst({
      ok: true,
      json: async () => [
        {
          messageId: 'one',
          role: 'assistant',
          blocks: [{ blockType: 'text', content: 'Stale first answer' }],
        },
      ],
    });
  });
  expect(screen.queryByText('Stale first answer')).toBeNull();
  expect(fetcher.mock.calls.every(([url]) => url.endsWith('/messages'))).toBe(true);
  expect(
    within(screen.getByRole('complementary', { name: 'Conversation preview' })).getByRole(
      'button',
      { name: 'Open conversation' },
    ),
  ).toBeTruthy();
});
