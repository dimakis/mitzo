// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TodoWorkspace } from '../TodoWorkspace';
import { markAuthLost } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: object) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/WorkOutputs', () => ({ WorkOutputs: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
it.each(['/todos', '/todos/qc-parent'])(
  'shows ten persisted report children at %s without legacy listing or hydration requests',
  async (path) => {
    markAuthLost();
    const template = createTelosWorkFixtures().homeStudio.items[0];
    const parent = {
      ...template,
      itemId: 'qc-parent',
      summary: 'Quarterly Connections',
      kind: null,
    };
    const records = [
      parent,
      ...Array.from({ length: 10 }, (_, i) => ({
        ...template,
        itemId: `report-${i}`,
        parentId: parent.itemId,
        summary: `Associate ${i}`,
        kind: null,
        profile: 'manual',
      })),
    ];
    const reads: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      reads.push(url);
      if (url === '/api/telos/work/collection')
        return Response.json({ records, profiles: ['work', 'manual'], failures: [] });
      if (url === '/api/telos/work/items/qc-parent/record') return Response.json(parent);
      if (url.endsWith('/lifecycle')) return Response.json({}, { status: 503 });
      const id = /\/items\/([^/]+)$/.exec(url)?.[1];
      if (id)
        return Response.json({
          itemId: id,
          kind: null,
          parentId: id === 'qc-parent' ? null : 'qc-parent',
          revision: 'a'.repeat(64),
          links: [],
          assignments: [],
          sources: [],
          attempts: [],
        });
      throw Error(`Unexpected read ${url}`);
    });
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/todos/:id?" element={<TodoWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
    const root = await screen.findByRole('button', { name: 'Associate 0' }).catch(async () => {
      const expand = await screen.findByRole('button', { name: 'Expand Quarterly Connections' });
      expand.click();
      return screen.findByRole('button', { name: 'Associate 0' });
    });
    expect(root).toBeTruthy();
    const tree = screen.getByRole('region', {
      name: path === '/todos' ? 'Outcomes tree' : 'Child work',
    });
    for (let i = 0; i < 10; i++)
      expect(within(tree).getByRole('button', { name: `Associate ${i}` })).toBeTruthy();
    expect(reads.filter((url) => url === '/api/telos/work/collection')).toHaveLength(1);
    expect(reads.some((url) => url.startsWith('/api/todos') || url.includes('/work/records'))).toBe(
      false,
    );
  },
);

it('keeps the canonical desktop frame while its exact item read is pending', async () => {
  markAuthLost();
  const record = {
    ...createTelosWorkFixtures().homeStudio.items[0],
    itemId: 'pending-item',
    parentId: null,
  };
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/api/telos/work/collection')
      return Response.json({ records: [record], profiles: ['manual'], failures: [] });
    if (url.endsWith('/record')) return pending;
    return Response.json({}, { status: 503 });
  });
  const view = render(
    <MemoryRouter initialEntries={['/todos/pending-item']}>
      <Routes>
        <Route path="/todos/:id?" element={<TodoWorkspace />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: record.summary });
  expect(view.container.querySelector('.todo-detail-page:not(.telos-canonical-page)')).toBeNull();
  release(Response.json(record));
});
