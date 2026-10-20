// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { TodoItem } from '../../types/todo';
import { TodoWorkspace } from '../TodoWorkspace';
import { apiFetch, AUTH_LOST_EVENT } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';

vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('../../hooks/useStageChatLaunch', () => ({ useStageChatLaunch: () => vi.fn() }));
vi.mock('../../components/HomePinButton', () => ({ HomePinButton: () => null }));
vi.mock('../../components/TelosItemRoleEntries', () => ({
  TelosItemRoleEntries: () => <p>Ordinary roles</p>,
}));
vi.mock('../../components/TelosItemSources', () => ({
  TelosItemSources: () => <p>Retained sources</p>,
}));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => <p>Saved outputs</p> }));
vi.mock('../../components/SavedArtifactRouteDialog', () => ({
  SavedArtifactRouteDialog: () => null,
}));

const homeState = { homeTab: 'home', scrollTop: 144, filesReturnState: { opaque: 'preserved' } };
const entryState = (item: TodoItem) => ({
  item,
  telosHistory: [],
  telosItemReturn: { path: '/?section=pins#retained', state: homeState },
  filesReturnState: { other: 'untouched' },
  activeProfile: 'manual',
  scrollTop: 72,
});
function item(id: string, parentId: string | null = null, children: TodoItem[] = []): TodoItem {
  return {
    id,
    parentId,
    children,
    summary: `Retained ${id}`,
    intent: 'Keep the original display',
    rationale: 'Offline route state is the only snapshot',
    acceptanceCriteria: ['Return to the correct parent'],
    profile: 'manual',
    urgency: 0,
    priority: 4,
    starred: false,
    status: 'active',
    ageDays: 0,
    childCount: children.length,
    completedChildCount: 0,
    sources: [],
    links: [],
    contextHints: {
      repos: [],
      paths: [],
      issues: [],
      docIds: [],
      people: [],
      jiraKeys: [],
      keywords: [],
      taskHint: '',
    },
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
function show(id: string, state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: `/todos/${id}`, state }]}>
      <Location />
      <Routes>
        <Route path="/todos/:id" element={<TodoWorkspace />} />
        <Route path="/todos" element={<h1>Collection</h1>} />
        <Route path="/" element={<h1>Home context</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}
const path = () => screen.getByLabelText('route-path').textContent;
const state = () => JSON.parse(screen.getByLabelText('route-state').textContent!);
async function summary(value: string) {
  await waitFor(() =>
    expect(document.querySelector('.todo-detail-summary')?.textContent).toBe(value),
  );
}
function milestone(child: TodoItem) {
  fireEvent.click(
    screen.getByText(child.summary, { exact: true }).closest('.todo-detail-child-row')!,
  );
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
    options?.method === 'POST'
      ? Response.json({ ok: true })
      : Response.json(
          { error: 'Both collection and canonical reads unavailable' },
          { status: 503 },
        ),
  );
});
afterEach(cleanup);

for (const childCanonical of [false, true])
  it(`restores the route-only parent and its acknowledged edit after ${childCanonical ? 'canonical' : 'legacy'} child Back while all parent/list reads fail`, async () => {
    const parentId = childCanonical ? 'canonical-child-parent' : 'legacy-child-parent';
    const child = item(parentId + '-child', parentId);
    const parent = item(parentId, null, [child]);
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    if (childCanonical)
      vi.mocked(apiFetch).mockImplementation(async (url, options) =>
        String(url) === `/api/telos/work/items/${child.id}/record`
          ? Response.json({
              ...createTelosWorkFixtures().homeStudio.items[1],
              itemId: child.id,
              parentId,
              summary: child.summary,
            })
          : original(url, options),
      );
    show(parent.id, entryState(parent));
    await summary(parent.summary);
    await screen.findByText('Outcome workspace unavailable. Showing original Telos fields.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: '8' },
    });
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe(
        '8',
      ),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/todos/${parent.id}/action`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'priority', priority: 8 }),
      }),
    );
    milestone(child);
    if (childCanonical) await screen.findByRole('heading', { name: child.summary });
    else await summary(child.summary);
    expect(path()).toBe(`/todos/${child.id}`);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await summary(parent.summary);
    expect(path()).toBe(`/todos/${parent.id}`);
    expect(state().item.id).toBe(parent.id);
    expect(state().item.priority).toBe(8);
    expect(state().filesReturnState).toEqual({ other: 'untouched' });
    expect(state().telosHistory).toEqual([]);
    expect((screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement).value).toBe(
      '8',
    );
    expect(apiFetch).toHaveBeenCalledWith('/api/todos');
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/telos/work/items/${parent.id}/record`,
      expect.anything(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(path()).toBe('/?section=pins#retained'));
    expect(state()).toEqual(homeState);
  });

it('retains each explicit parent snapshot through nested descent and a route-state remount', async () => {
  const grandchild = item('route-grandchild', 'route-child');
  const child = item('route-child', 'route-parent', [grandchild]);
  const parent = item('route-parent', null, [child]);
  const rendered = show(parent.id, entryState(parent));
  await summary(parent.summary);
  milestone(child);
  await summary(child.summary);
  milestone(grandchild);
  await summary(grandchild.summary);
  const retained = state();
  expect(retained.telosHistory).toEqual([parent.id, child.id]);
  rendered.unmount();
  show(grandchild.id, retained);
  await summary(grandchild.summary);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await summary(child.summary);
  expect(state().item.id).toBe(child.id);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await summary(parent.summary);
  expect(state().item.id).toBe(parent.id);
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(path()).toBe('/?section=pins#retained'));
  expect(state()).toEqual(homeState);
});
