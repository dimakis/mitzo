// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, type InitialEntry } from 'react-router-dom';
import { HomePins } from '../../components/HomePins';
import { TodoWorkspace } from '../TodoWorkspace';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
const records = createTelosWorkFixtures().homeStudio.items;
const controls = vi.hoisted(() => ({
  unavailable: false,
  childRead: null as null | (() => Promise<Response>),
  parentRead: null as null | (() => Promise<Response>),
  update: vi.fn(),
}));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({
    loading: false,
    saving: false,
    error: null,
    update: controls.update,
    preferences: {
      revision: 1,
      names: { briefing: 'Minion', terminal: 'Minion' },
      pins: [
        { kind: 'telos', id: 'fixture-studio', title: 'Home studio' },
        { kind: 'session', id: 'existing-chat', title: 'Existing conversation' },
      ],
    },
  }),
}));
vi.mock('../../hooks/useSessionDisplay', () => ({
  useSessionDisplay: () => ({ showContext: false }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('../../hooks/useStageChatLaunch', () => ({ useStageChatLaunch: () => vi.fn() }));
vi.mock('../../components/TelosItemRoleEntries', () => ({
  TelosItemRoleEntries: () => <p>Ordinary roles</p>,
}));
vi.mock('../../components/TelosTreeConversationEntry', () => ({
  TelosTreeConversationEntry: () => <span>Conversation entry</span>,
}));
vi.mock('../../components/TelosItemSources', () => ({
  TelosItemSources: () => <p>Retained sources</p>,
}));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => <p>Saved outputs</p> }));
vi.mock('../../components/SavedArtifactRouteDialog', () => ({
  SavedArtifactRouteDialog: () => null,
}));
vi.mock('../../hooks/useTodoData', async (original) => ({
  ...(await original<typeof import('../../hooks/useTodoData')>()),
  useTodoData: () => ({
    loading: false,
    refreshing: false,
    error: null,
    items: [legacy(records[0].itemId)],
    profiles: ['manual'],
    refresh: vi.fn(),
    setPriority: vi.fn(),
    create: vi.fn(),
    ack: vi.fn(),
    done: vi.fn(),
    star: vi.fn(),
  }),
}));
vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(async function read(path: string, init?: RequestInit): Promise<Response> {
    if (path === '/api/telos/work/records')
      return (await import('../../test-utils/telos-record-batch')).telosRecordBatchFixture(
        init,
        (id) => read('/api/telos/work/items/' + encodeURIComponent(id) + '/record'),
      );
    const id = path.match(/\/api\/telos\/work\/items\/([^/]+)\/record$/)?.[1];
    const record = records.find((value) => value.itemId === id);
    if (id === records[0].itemId && controls.parentRead) return controls.parentRead();
    if (id === records[1].itemId && controls.childRead) return controls.childRead();
    if (id)
      return record && !controls.unavailable
        ? Response.json(record)
        : Response.json({ error: 'unavailable' }, { status: 503 });
    throw Error('Unexpected request ' + path);
  }),
}));
function legacy(id: string): object {
  const record = records.find((record) => record.itemId === id)!;
  return {
    id,
    summary: record.summary,
    profile: record.profile,
    urgency: 0,
    priority: record.priority,
    ageDays: 0,
    status: record.status,
    starred: false,
    parentId: record.parentId,
    childCount: records.filter((child) => child.parentId === id).length,
    completedChildCount: 0,
    children: records.filter((child) => child.parentId === id).map((child) => legacy(child.itemId)),
    sources: [],
    links: [],
    contextHints: record.contextHints,
    goalId: null,
  };
}
function Location() {
  const location = useLocation();
  return (
    <>
      <output aria-label="route-path">{location.pathname + location.search + location.hash}</output>
      <output aria-label="route-state">{JSON.stringify(location.state)}</output>
    </>
  );
}
function Home() {
  return (
    <>
      <h1>Home context</h1>
      <HomePins sessions={[]} />
    </>
  );
}
function show(entries: InitialEntry[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Location />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/todos" element={<h1>Collection</h1>} />
        <Route path="/todos/:id" element={<TodoWorkspace />} />
        <Route path="/chat/:id" element={<h1>Ordinary chat</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}
const path = () => screen.getByLabelText('route-path').textContent;
const state = () => JSON.parse(screen.getByLabelText('route-state').textContent!);
async function pin() {
  fireEvent.click(screen.getByRole('link', { name: /^Home studio\s*Work/ }));
  await screen.findByRole('heading', { name: records[0].summary });
}
async function back() {
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
}
beforeEach(() => {
  controls.unavailable = false;
  controls.childRead = null;
  controls.parentRead = null;
  controls.update.mockReset();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

it('returns the actual Home pin entry to Home, restoring its query/hash/state without browser-history guessing', async () => {
  const homeState = {
    homeTab: 'home',
    scrollTop: 144,
    filesReturnState: { from: '/files?path=retained' },
  };
  show([{ pathname: '/', search: '?section=pins', hash: '#pinned', state: homeState }]);
  await pin();
  expect(path()).toBe('/todos/fixture-studio');
  await back();
  await waitFor(() => expect(path()).toBe('/?section=pins#pinned'));
  expect(state()).toEqual(homeState);
  expect(controls.update).not.toHaveBeenCalled();
});
it('starts an explicit fresh item trail from Home instead of adopting an older device visit', async () => {
  sessionStorage.setItem('telos.item.history.fixture-studio', JSON.stringify(['stale-other-item']));
  show();
  await pin();
  await waitFor(() =>
    expect(JSON.parse(sessionStorage.getItem('telos.item.history.fixture-studio')!)).toEqual([]),
  );
  await back();
  await waitFor(() => expect(path()).toBe('/'));
});
it('pops the actual parent item trail before consuming Home entry context', async () => {
  show();
  await pin();
  fireEvent.click(await screen.findByRole('button', { name: records[1].summary }));
  await screen.findByRole('heading', { name: records[1].summary });
  await back();
  await screen.findByRole('heading', { name: records[0].summary });
  expect(path()).toBe('/todos/fixture-studio');
  await back();
  await waitFor(() => expect(path()).toBe('/'));
});
it('retains Home entry across a same-item route-state remount such as a reload/Files return', async () => {
  const rendered = show();
  await pin();
  const retained = state();
  rendered.unmount();
  show([
    {
      pathname: '/todos/fixture-studio',
      search: '?view=Overview',
      state: { ...retained, filesReturnState: { opaque: 'retain' } },
    },
  ]);
  await screen.findByRole('heading', { name: records[0].summary });
  await back();
  await waitFor(() => expect(path()).toBe('/'));
});
it('keeps the safe direct-open collection fallback despite another browser history entry', async () => {
  show(['/chat/unrelated', '/todos/fixture-studio']);
  await screen.findByRole('heading', { name: records[0].summary });
  await back();
  await waitFor(() => expect(path()).toBe('/todos'));
});
it('preserves list profile, scroll and unrelated Files return state on the existing collection path', async () => {
  const retained = {
    activeProfile: 'manual',
    scrollTop: 240,
    telosHistory: [],
    filesReturnState: { opaque: 'unchanged' },
  };
  show([{ pathname: '/todos/fixture-studio', state: retained }]);
  await screen.findByRole('heading', { name: records[0].summary });
  await back();
  await waitFor(() => expect(path()).toBe('/todos'));
  expect(state()).toEqual(retained);
});
it('keeps session pins on their ordinary conversation path without a Telos Home return claim', async () => {
  show();
  fireEvent.click(screen.getByRole('link', { name: /^Existing conversation\s*Session/ }));
  expect(path()).toBe('/chat/existing-chat');
  expect(state()).toBeNull();
});
it('returns Home through the existing legacy fallback when its canonical record is unavailable', async () => {
  controls.unavailable = true;
  show();
  fireEvent.click(screen.getByRole('link', { name: /^Home studio\s*Work/ }));
  await screen.findByRole('heading', { name: 'Task' });
  await back();
  await waitFor(() => expect(path()).toBe('/'));
});
for (const unsafe of [
  'https://outside.invalid/',
  '//outside.invalid/',
  '/\\outside.invalid/',
  'javascript:alert(1)',
  '/chat/other',
  '/todos/other',
  '/else/..',
  '/%2f%2foutside.invalid',
  '/\n',
])
  it(`rejects an unrelated or unsafe Home return destination ${JSON.stringify(unsafe)}`, async () => {
    show([
      {
        pathname: '/todos/fixture-studio',
        state: { telosHistory: [], telosItemReturn: { path: unsafe, state: { notHome: true } } },
      },
    ]);
    await screen.findByRole('heading', { name: records[0].summary });
    await back();
    await waitFor(() => expect(path()).toBe('/todos'));
  });

for (const mode of ['pending', 'unavailable'] as const)
  it(`pops the parent trail before Home when the child canonical read is ${mode}`, async () => {
    const homeState = {
      homeTab: 'home',
      scrollTop: 144,
      filesReturnState: { from: '/files?path=retained' },
    };
    show([{ pathname: '/', search: '?section=pins', hash: '#pinned', state: homeState }]);
    await pin();
    const child = await screen.findByRole('button', { name: records[1].summary });
    const parentState = state();
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const childRead = vi.fn(() =>
      mode === 'pending'
        ? held
        : Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })),
    );
    controls.childRead = childRead;
    await act(async () => {
      fireEvent.click(child);
    });
    expect(childRead).toHaveBeenCalledOnce();
    expect(path()).toBe('/todos/fixture-studio-slice');
    expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
    expect(state()).toEqual({
      ...parentState,
      telosHistory: ['fixture-studio'],
      telosHistorySnapshots: [legacy(records[0].itemId)],
    });
    await back();
    await screen.findByRole('heading', { name: records[0].summary });
    expect(path()).toBe('/todos/fixture-studio');
    expect(state()).toEqual({ ...parentState, item: legacy(records[0].itemId) });
    expect(JSON.parse(sessionStorage.getItem('telos.item.history.fixture-studio')!)).toEqual([]);
    if (mode === 'pending') {
      await act(async () => {
        release(Response.json(records[1]));
      });
      expect(path()).toBe('/todos/fixture-studio');
      expect(screen.getByRole('heading', { name: records[0].summary })).toBeTruthy();
    }
    await back();
    await waitFor(() => expect(path()).toBe('/?section=pins#pinned'));
    expect(state()).toEqual(homeState);
    expect(controls.update).not.toHaveBeenCalled();
  });

for (const mode of ['pending', 'unavailable'] as const)
  it(`retains parent and Home context through legacy Milestones while the parent canonical read is ${mode}`, async () => {
    const homeState = {
      homeTab: 'home',
      scrollTop: 144,
      activeProfile: 'manual',
      filesReturnState: { from: '/files?path=retained' },
    };
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const parentRead = vi.fn(() =>
      mode === 'pending'
        ? held
        : Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })),
    );
    controls.parentRead = parentRead;
    sessionStorage.setItem(
      'telos.item.history.fixture-studio-slice',
      JSON.stringify(['stale-other-parent']),
    );
    show([{ pathname: '/', search: '?section=pins', hash: '#pinned', state: homeState }]);
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^Home studio\s*Work/ }));
    });
    expect(parentRead).toHaveBeenCalledOnce();
    expect(path()).toBe('/todos/fixture-studio');
    expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Milestones/ })).toBeTruthy();
    const retained = state();
    const milestone = screen.getByText(records[1].summary).closest('.todo-detail-child-row')!;
    expect(milestone).toBeTruthy();
    fireEvent.click(milestone);
    await screen.findByRole('heading', { name: records[1].summary });
    expect(path()).toBe('/todos/fixture-studio-slice');
    await back();
    await waitFor(() => expect(path()).toBe('/todos/fixture-studio'));
    expect(screen.getByRole('heading', { name: 'Task' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /^Milestones/ })).toBeTruthy();
    expect(state().telosHistory).toEqual([]);
    expect(state().telosItemReturn).toEqual(retained.telosItemReturn);
    expect(JSON.parse(sessionStorage.getItem('telos.item.history.fixture-studio-slice')!)).toEqual([
      'fixture-studio',
    ]);
    await back();
    await waitFor(() => expect(path()).toBe('/?section=pins#pinned'));
    expect(state()).toEqual(homeState);
    if (mode === 'pending') {
      await act(async () => {
        release(Response.json(records[0]));
      });
      expect(path()).toBe('/?section=pins#pinned');
      expect(state()).toEqual(homeState);
    }
    expect(controls.update).not.toHaveBeenCalled();
  });
