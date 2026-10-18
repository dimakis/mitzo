// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { TelosWorkItem } from '@mitzo/protocol';
import { TodoWorkspace } from '../TodoWorkspace';
import { FileViewer } from '../FileViewer';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { markAuthLost } from '../../lib/api-fetch';
import { installDialogStub } from '../../components/__tests__/dialog-stub';

vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: Record<string, unknown>) => unknown) =>
    select({ newSession: vi.fn(), setPendingSession: vi.fn() }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('../../lib/event-bus-singleton', () => ({ eventBus: { on: () => () => {} } }));
vi.mock('../../components/TelosItemRoleEntries', () => ({ TelosItemRoleEntries: () => null }));
vi.mock('../../components/TelosItemSources', () => ({ TelosItemSources: () => null }));
vi.mock('../../components/UserOutputUpload', () => ({ UserOutputUpload: () => null }));
vi.mock('../../hooks/useDocumentReader', () => ({
  useDocumentReader: () => ({ available: false, state: 'idle', stop: vi.fn(), read: vi.fn() }),
}));
vi.mock('../../hooks/useEditorViewport', () => ({ useEditorViewport: () => ({ current: null }) }));
vi.mock('../../components/DocumentEditor', () => ({
  DocumentEditor: ({ content, onChange }: { content: string; onChange(value: string): void }) => (
    <textarea
      aria-label="Document editor fixture"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const root = createTelosWorkFixtures().homeStudio.items[0];
const id = 'a'.repeat(32);
const itemId = 'return-child-11';
const version = (revision: number) => ({
  id,
  itemId,
  filename: 'return-plan.md',
  title: 'Return plan',
  revision,
  size: 40,
  sha256: String(revision).repeat(64),
  url: '/api/telos/artifacts/' + id + '?revision=' + revision,
  sourceKind: 'session_artifact' as const,
  sessionId: 'fixture-source',
  sourcePath: 'return-plan.md',
  createdAt: '2026-10-16T10:00:00Z',
});
let records: TelosWorkItem[];
let latest: number;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
function legacy(record: TelosWorkItem): unknown {
  const children = records.filter((r) => r.parentId === record.itemId).map(legacy);
  return {
    id: record.itemId,
    summary: record.summary,
    profile: 'manual',
    urgency: 1,
    priority: record.priority,
    starred: false,
    status: 'active',
    ageDays: 0,
    parentId: record.parentId,
    children,
    childCount: children.length,
    completedChildCount: 0,
    sources: [],
    links: [],
    contextHints: record.contextHints,
    goalId: null,
  };
}
function Probe() {
  const location = useLocation();
  return (
    <>
      <output aria-label="Route">{location.pathname + location.search}</output>
      <output aria-label="Return state">{JSON.stringify(location.state)}</output>
    </>
  );
}
const scroller = () => document.querySelector<HTMLElement>('.todo-scroll')!;
beforeEach(() => {
  markAuthLost();
  installDialogStub();
  localStorage.clear();
  sessionStorage.clear();
  latest = 4;
  records = [
    root,
    ...Array.from({ length: 12 }, (_, i) => ({
      ...root,
      itemId: 'return-child-' + i,
      parentId: root.itemId,
      kind: 'work_item' as const,
      summary: 'Deep return child ' + i,
    })),
  ];
  localStorage.setItem(
    'telos.outcomes.navigation.v1',
    JSON.stringify({
      query: 'Deep',
      category: 'All',
      pins: [],
      expanded: [root.itemId],
      filter: 'All outcomes',
    }),
  );
  const positions = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return positions.get(this) ?? 0;
    },
    set(value: number) {
      const max = this.matches('.todo-scroll')
        ? Math.max(0, this.querySelectorAll('.telos-tree-row').length * 120 - 500)
        : Number.MAX_SAFE_INTEGER;
      positions.set(this, Math.max(0, Math.min(value, max)));
    },
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(path, 'https://mitzo-ui.test');
    if (url.pathname === '/api/todos')
      return Response.json({
        profiles: ['manual'],
        items: records.filter((r) => !r.parentId).map(legacy),
      });
    const match = url.pathname.match(/^\/api\/telos\/work\/items\/([^/]+)(\/record)?$/);
    if (match) {
      const record = records.find((r) => r.itemId === match[1])!;
      return Response.json(
        match[2]
          ? record
          : {
              itemId: record.itemId,
              kind: record.kind,
              parentId: record.parentId,
              revision: 'f'.repeat(64),
              links: [],
              assignments: [],
              sources: [],
              attempts: [],
            },
      );
    }
    if (/^\/api\/telos\/items\/[^/]+\/artifacts$/.test(url.pathname))
      return Response.json({
        artifacts: url.pathname.includes('/' + itemId + '/') ? [version(3)] : [],
        limit: 100,
      });
    if (url.pathname === '/api/telos/artifacts/' + id + '/versions')
      return Response.json({
        artifacts: Array.from({ length: latest - 2 }, (_, i) => version(latest - i)).filter(
          (row) =>
            row.revision <
            Number(url.searchParams.get('beforeRevision') || Number.MAX_SAFE_INTEGER),
        ),
        cursor: null,
        hasMore: false,
      });
    if (url.pathname === '/api/telos/artifacts/' + id + '/document') {
      if (init?.method === 'PUT') {
        latest = 5;
        return Response.json({ artifact: version(5) });
      }
      const revision = Number(url.searchParams.get('revision'));
      return Response.json({
        path: version(revision).url,
        name: 'return-plan.md',
        ext: '.md',
        revision,
        content: '# Retained return plan r' + revision,
        editable: true,
        previewUnavailable: false,
      });
    }
    if (url.pathname === '/api/home/preferences')
      return Response.json({
        revision: 0,
        names: { briefing: 'Minion', terminal: 'Minion' },
        pins: [],
      });
    throw Error('Unexpected output-return fixture request: ' + path);
  });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(Element.prototype, 'scrollTop', scrollDescriptor);
  vi.restoreAllMocks();
});

it.each(['done', 'version', 'files', 'files-edit', 'work-item', 'nested', 'reference'] as const)(
  'preserves deep collection return state through the real output %s journey',
  async (journey) => {
    if (journey === 'reference') {
      records.find((record) => record.itemId === itemId)!.links = [
        {
          type: 'artifact',
          url: version(3).url,
          title: 'Saved return reference',
          description: 'Pinned saved version 3',
          addedAt: root.updatedAt,
        },
      ];
    }
    render(
      <MemoryRouter initialEntries={[{ pathname: '/todos', state: { activeProfile: 'manual' } }]}>
        <Probe />
        <Routes>
          <Route path="/todos/:id?" element={<TodoWorkspace />} />
          <Route path="/files" element={<FileViewer />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Deep return child 11' });
    scroller().scrollTop = 600;
    expect(scroller().scrollTop).toBe(600);
    if (journey === 'nested') {
      fireEvent.click(screen.getByRole('button', { name: 'Home studio setup' }));
      await screen.findByRole('heading', { name: 'Home studio setup' });
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Deep return child 11' }));
    await screen.findByRole('heading', { name: 'Deep return child 11' });
    fireEvent.click(screen.getByRole('button', { name: 'Materials' }));
    if (journey === 'reference') {
      fireEvent.click(await screen.findByRole('link', { name: /^Saved return reference/ }));
      await waitFor(() => expect(document.querySelector('.viewer-page')).toBeTruthy());
      await screen.findByRole('heading', { name: 'Retained return plan r3' });
      fireEvent.click(
        within(document.querySelector<HTMLElement>('.viewer-page')!).getByRole('button', {
          name: 'Back',
        }),
      );
      await screen.findByRole('heading', { name: 'Deep return child 11' });
    } else {
      fireEvent.click(await screen.findByRole('link', { name: 'Return plan' }));
      await screen.findByRole('heading', { name: 'Retained return plan r3' });
      if (['version', 'files', 'files-edit'].includes(journey)) {
        fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), {
          target: { value: '4' },
        });
        await screen.findByRole('heading', { name: 'Retained return plan r4' });
      }
      if (journey === 'files' || journey === 'files-edit') {
        fireEvent.click(screen.getByRole('button', { name: 'File options' }));
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
        await waitFor(() => expect(document.querySelector('.viewer-page')).toBeTruthy());
        await screen.findByRole('heading', { name: 'Retained return plan r4' });
        if (journey === 'files-edit') {
          fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
          fireEvent.change(screen.getByRole('textbox', { name: 'Document editor fixture' }), {
            target: { value: '# Saved return plan r5' },
          });
          fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
          await waitFor(() =>
            expect(screen.getByLabelText('Route').textContent).toContain('revision%3D5'),
          );
        }
        fireEvent.click(
          within(document.querySelector<HTMLElement>('.viewer-page')!).getByRole('button', {
            name: 'Back',
          }),
        );
        await screen.findByRole('heading', { name: 'Retained return plan r4' });
      }
      if (journey === 'work-item')
        fireEvent.click(screen.getByRole('link', { name: 'Open Work item' }));
      else fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    if (journey === 'nested') {
      await screen.findByRole('heading', { name: 'Home studio setup' });
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    }
    await screen.findByRole('button', { name: 'Deep return child 11' });
    await waitFor(() => expect(scroller().scrollTop).toBe(600));
    expect(JSON.parse(screen.getByLabelText('Return state').textContent!)).toMatchObject({
      activeProfile: 'manual',
      scrollTop: 600,
      telosHistory: [],
    });
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Deep');
  },
);
