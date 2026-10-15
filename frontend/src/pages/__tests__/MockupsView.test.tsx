// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { MockupsView } from '../MockupsView';
import { readApiJson } from '../../lib/api-json-read';
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
vi.mock('../../hooks/useSessionList', () => ({
  useSessionList: () => ({
    sessions: [{ id: 'one', summary: 'Product exploration', lastModified: 1 }],
    loading: false,
    error: null,
    hasMore: false,
    retry: vi.fn(),
  }),
}));
vi.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => ({
    query: '',
    setQuery: vi.fn(),
    results: [],
    active: false,
    searching: false,
    error: null,
  }),
}));
vi.mock('../../components/MockupCollection', () => ({
  MockupCollection: ({
    mockups,
    sessionId,
  }: {
    mockups: { title: string }[];
    sessionId: string;
  }) => (
    <p>
      {sessionId}: {mockups.map((item) => item.title).join(', ')}
    </p>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const history = [
  {
    messageId: 'a',
    role: 'assistant',
    blocks: [
      {
        blockId: 'b',
        blockType: 'text',
        content: '[Release checklist](/task/mockups/release/v001.html)',
      },
    ],
  },
];
it('chooses a chat before reading saved history, with a return path to the picker', async () => {
  vi.mocked(readApiJson).mockResolvedValue(history);
  render(
    <MemoryRouter initialEntries={['/mockups']}>
      <MockupsView />
    </MemoryRouter>,
  );
  expect(readApiJson).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: /Product exploration/ }));
  await screen.findByText('one: Release checklist');
  expect(readApiJson).toHaveBeenCalledWith('/api/sessions/one/messages', expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('link', { name: 'Choose another chat' }));
  expect(screen.getByRole('link', { name: /Product exploration/ })).toBeTruthy();
});
it('retains read errors with retry instead of reporting no mockups', async () => {
  vi.mocked(readApiJson).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(history);
  render(
    <MemoryRouter initialEntries={['/mockups?sessionId=one']}>
      <MockupsView />
    </MemoryRouter>,
  );
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
  await screen.findByText('one: Release checklist');
});
it('fences late history when switching chat URLs, including history with no mockups', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(readApiJson)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish;
        }),
    )
    .mockResolvedValueOnce([]);
  function Switch() {
    const nav = useNavigate();
    return <button onClick={() => nav('/mockups?sessionId=two')}>Switch</button>;
  }
  render(
    <MemoryRouter initialEntries={['/mockups?sessionId=one']}>
      <Switch />
      <MockupsView />
    </MemoryRouter>,
  );
  await waitFor(() => expect(readApiJson).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Switch' }));
  await screen.findByText('two:');
  await act(async () => finish(history));
  expect(screen.queryByText(/Release checklist/)).toBeNull();
});
