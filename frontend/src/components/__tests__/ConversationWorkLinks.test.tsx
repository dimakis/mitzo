// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '@mitzo/client';
import { ConversationWorkLinks } from '../SessionWorkLink';
vi.mock('../../hooks/useTodoData', () => ({
  useTodoData: () => ({ items: [] }),
  findInTree: () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('exposes all recorded item backlinks for a shared origin without choosing a lead or counting a role twice', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'links').mockResolvedValue([
    { itemId: 'one', role: 'origin' },
    { itemId: 'two', role: 'origin' },
    { itemId: 'one', role: 'advisor' },
  ] as never);
  render(
    <MemoryRouter>
      <ConversationWorkLinks conversationId="planning" />
    </MemoryRouter>,
  );
  const links = await screen.findAllByRole('link');
  expect(links.map((l) => l.getAttribute('href'))).toEqual(['/todos/one', '/todos/two']);
});
it('discards late associations after switching conversations', async () => {
  let finish!: (v: never) => void;
  vi.spyOn(TelosWorkApiClient.prototype, 'links')
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    )
    .mockResolvedValue([]);
  const surface = render(
    <MemoryRouter>
      <ConversationWorkLinks conversationId="old" />
    </MemoryRouter>,
  );
  surface.rerender(
    <MemoryRouter>
      <ConversationWorkLinks conversationId="new" />
    </MemoryRouter>,
  );
  await act(async () => finish([{ itemId: 'old-item', role: 'origin' }] as never));
  expect(screen.queryByRole('link')).toBeNull();
});
