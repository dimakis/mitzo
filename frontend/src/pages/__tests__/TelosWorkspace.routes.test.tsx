import { useNewChatDraft } from '../../hooks/useNewChatDraft';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
const records = createTelosWorkFixtures().homeStudio.items;
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (s: (v: unknown) => unknown) =>
    s({ setPendingSession: vi.fn(), newSession: vi.fn() }),
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({
  TelosItemRoleEntries: () => <p>Ordinary conversations</p>,
}));
vi.mock('../../components/TelosItemSources', () => ({
  TelosItemSources: () => <p>Source references</p>,
}));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => <p>Saved outputs</p> }));
vi.mock('../../hooks/useTodoData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useTodoData')>()),
  useTodoData: () => ({
    loading: false,
    error: null,
    items: [
      {
        id: 'fixture-studio',
        summary: 'Home studio setup',
        profile: 'manual',
        urgency: 1,
        ageDays: 0,
        status: 'active',
        starred: false,
        parentId: null,
        childCount: 1,
        completedChildCount: 0,
        sources: [],
        contextHints: records[0].contextHints,
        children: [
          {
            id: 'fixture-studio-slice',
            summary: 'Plan the recording setup',
            profile: 'manual',
            urgency: 1,
            ageDays: 0,
            status: 'active',
            starred: false,
            parentId: 'fixture-studio',
            childCount: 0,
            completedChildCount: 0,
            sources: [],
            contextHints: records[1].contextHints,
            children: [],
          },
        ],
      },
    ],
    profiles: ['manual'],
    refresh: vi.fn(),
    create: vi.fn(),
    ack: vi.fn(),
    done: vi.fn(),
    star: vi.fn(),
  }),
}));
vi.mock('../../lib/api-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(async function read(url: string, init?: RequestInit): Promise<Response> {
    if (url === '/api/telos/work/records')
      return (await import('../../test-utils/telos-record-batch')).telosRecordBatchFixture(
        init,
        (id) => read('/api/telos/work/items/' + encodeURIComponent(id) + '/record'),
      );
    const id = url.split('/').at(-2);
    const record = records.find((r) => r.itemId === id);
    if (url.endsWith('/record') && record) return new Response(JSON.stringify(record));
    throw Error('Unexpected route ' + url);
  }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
it('opens actual record workspace from All outcomes, navigates child and returns with query intact', async () => {
  render(
    <MemoryRouter initialEntries={['/todos']}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'All outcomes' });
  expect(screen.getByRole('button', { name: 'New item' })).toBeTruthy();
  const list = document.body;
  fireEvent.change(within(list).getByRole('searchbox'), { target: { value: 'recording' } });
  fireEvent.click(within(list).getByRole('button', { name: 'Plan the recording setup' }));
  const detail = document.body;
  await within(detail).findByRole('heading', { name: 'Plan the recording setup' });
  expect(within(detail).queryByRole('button', { name: 'Work' })).toBeNull();
  fireEvent.click(within(detail).getByRole('button', { name: 'Back' }));
  await waitFor(() =>
    expect((within(list).getByRole('searchbox') as HTMLInputElement).value).toBe('recording'),
  );
});

function OrdinaryPlanningOwner() {
  const [params] = useSearchParams();
  const owner = useNewChatDraft(params.get('draft'), 0, true);
  return (
    <>
      <h1>Ordinary planning conversation</h1>
      <output>{owner.draft.text}</output>
      <output aria-label="Retained launch">
        {owner.draft.settings.launch ? 'Launch' : 'Unsent composer'}
      </output>
    </>
  );
}
it('hands New item to the real ordinary draft owner with a retained planning prompt and no mandatory form', async () => {
  render(
    <MemoryRouter initialEntries={['/todos']}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
        <Route path="/chat" element={<OrdinaryPlanningOwner />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'All outcomes' });
  fireEvent.click(screen.getByRole('button', { name: 'New item' }));
  await screen.findByRole('heading', { name: 'Ordinary planning conversation' });
  expect(screen.getByText(/Help me plan a new Telos outcome/)).toBeTruthy();
  expect(screen.getByLabelText('Retained launch').textContent).toBe('Unsent composer');
  expect(screen.queryByPlaceholderText('Milestones — first line is the next action')).toBeNull();
});
