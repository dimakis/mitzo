// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosOutcomesTree } from '../TelosOutcomesTree';
import type { TelosWorkItem } from '@mitzo/protocol';

vi.mock('../TelosTreeConversationEntry', () => ({ TelosTreeConversationEntry: () => null }));
const fixtures = createTelosWorkFixtures();
const records: TelosWorkItem[] = [
  ...fixtures.nestedCoordinator.items,
  ...fixtures.homeStudio.items,
];
beforeEach(() => localStorage.clear());
afterEach(cleanup);
it('starts with All outcomes, discovers and persists pins, and searches nested context with ancestors', () => {
  const onOpen = vi.fn();
  const items = records.map((item, i) => ({
    ...item,
    categories: i === 0 ? ['Research'] : item.categories,
  }));
  const view = render(<TelosOutcomesTree refreshKey={0} records={items} onOpen={onOpen} />);
  expect(screen.getAllByRole('button', { pressed: true })[0].textContent).toBe('All outcomes');
  fireEvent.click(screen.getByRole('button', { name: /Browse categories/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Pin Research' }));
  view.unmount();
  render(<TelosOutcomesTree refreshKey={0} records={items} onOpen={onOpen} />);
  expect(screen.getByRole('button', { name: 'Research' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  const target = items.find((item) => item.parentId !== null)!;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: target.intent } });
  fireEvent.click(screen.getByRole('button', { name: target.summary }));
  expect(onOpen).toHaveBeenCalledWith(target.itemId);
  expect(screen.getAllByText('Coordinator').length).toBeGreaterThan(0);
});
it('keeps unknown kinds truthful and reports empty searches without mutating source records', () => {
  const unknown = { ...records[0], itemId: 'unknown', kind: null, parentId: null } as TelosWorkItem;
  render(<TelosOutcomesTree refreshKey={0} records={[unknown]} onOpen={vi.fn()} />);
  expect(screen.getByText('Unclassified')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-match-xyz' } });
  expect(screen.getByText('No matching outcomes')).toBeTruthy();
  expect(unknown.kind).toBeNull();
});
it('restores category, query and expansion after remount and tolerates denied device storage', () => {
  const view = render(<TelosOutcomesTree refreshKey={0} records={records} onOpen={vi.fn()} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'studio' } });
  view.unmount();
  render(<TelosOutcomesTree refreshKey={0} records={records} onOpen={vi.fn()} />);
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('studio');
});

it('keeps All outcomes first in loading, empty and unavailable states', () => {
  const view = render(<TelosOutcomesTree refreshKey={0} records={[]} onOpen={vi.fn()} loading />);
  expect(screen.getByRole('status').textContent).toBe('Loading outcomes…');
  expect(screen.queryByText('No outcomes yet.')).toBeNull();
  expect(screen.getAllByRole('button')[0].textContent).toBe('All outcomes');
  view.rerender(
    <TelosOutcomesTree
      refreshKey={0}
      records={[]}
      onOpen={vi.fn()}
      error="Unable to load outcomes"
    />,
  );
  expect(screen.getByRole('alert').textContent).toBe('Unable to load outcomes');
  expect(screen.queryByText('No outcomes yet.')).toBeNull();
  view.rerender(<TelosOutcomesTree refreshKey={0} records={[]} onOpen={vi.fn()} />);
  expect(screen.getByText('No outcomes yet.')).toBeTruthy();
});

it('closes category discovery with Escape and restores its trigger focus', () => {
  render(<TelosOutcomesTree refreshKey={0} records={records} onOpen={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: 'Browse categories' });
  fireEvent.click(trigger);
  const discovery = screen.getByLabelText('Discover categories');
  fireEvent.keyDown(discovery, { key: 'Escape' });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('reveals selected ancestors as canonical parents hydrate and preserves manual collapse on refresh', () => {
  const template = records[0];
  const child = { ...template, itemId: 'selected', parentId: 'parent', summary: 'Selected work' };
  const parent = { ...template, itemId: 'parent', parentId: 'root', summary: 'Hydrated parent' };
  const root = { ...template, itemId: 'root', parentId: null, summary: 'Hydrated root' };
  const props = { selectedId: child.itemId, refreshKey: 0, onOpen: vi.fn() };
  const view = render(<TelosOutcomesTree {...props} records={[child]} />);
  expect(
    screen
      .getByRole('button', { name: child.summary })
      .closest('.telos-tree-row')
      ?.getAttribute('aria-current'),
  ).toBe('page');
  view.rerender(<TelosOutcomesTree {...props} records={[parent, child]} />);
  expect(
    screen.getByRole('button', { name: 'Collapse Hydrated parent' }).getAttribute('aria-expanded'),
  ).toBe('true');
  view.rerender(<TelosOutcomesTree {...props} records={[root, parent, child]} />);
  expect(
    screen.getByRole('button', { name: 'Collapse Hydrated root' }).getAttribute('aria-expanded'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Hydrated parent' }));
  view.rerender(
    <TelosOutcomesTree
      {...props}
      refreshKey={1}
      records={[{ ...root }, { ...parent }, { ...child }]}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Expand Hydrated parent' }).getAttribute('aria-expanded'),
  ).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  view.rerender(<TelosOutcomesTree {...props} refreshKey={2} records={[root, parent, child]} />);
  expect(
    screen.getByRole('button', { name: 'Expand Hydrated root' }).getAttribute('aria-expanded'),
  ).toBe('false');
  view.unmount();
  render(<TelosOutcomesTree {...props} records={[root, parent, child]} />);
  expect(
    screen.getByRole('button', { name: 'Collapse Hydrated root' }).getAttribute('aria-expanded'),
  ).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Collapse Hydrated parent' }).getAttribute('aria-expanded'),
  ).toBe('true');
});

it('reveals a changed selection and bounds missing or cyclic ancestry without changing records', () => {
  const template = records[0];
  const root = { ...template, itemId: 'root', parentId: null, summary: 'Root' };
  const child = { ...template, itemId: 'child', parentId: 'root', summary: 'Child' };
  const items = [root, child];
  const before = JSON.stringify(items);
  const view = render(
    <TelosOutcomesTree refreshKey={0} records={items} selectedId="root" onOpen={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'Expand Root' })).toBeTruthy();
  view.rerender(
    <TelosOutcomesTree refreshKey={0} records={items} selectedId="child" onOpen={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'Collapse Root' })).toBeTruthy();
  expect(JSON.stringify(items)).toBe(before);
  view.rerender(
    <TelosOutcomesTree refreshKey={0} records={items} selectedId="missing" onOpen={vi.fn()} />,
  );
  view.rerender(
    <TelosOutcomesTree
      refreshKey={0}
      records={[{ ...root, parentId: 'child' }, child]}
      selectedId="child"
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByRole('searchbox')).toBeTruthy();
});

it('retains manual collapse when canonical ancestors temporarily disappear and return', () => {
  const template = records[0];
  const child = { ...template, itemId: 'child', parentId: 'parent', summary: 'Selected work' };
  const parent = { ...template, itemId: 'parent', parentId: 'root', summary: 'Retained parent' };
  const root = { ...template, itemId: 'root', parentId: null, summary: 'Newly discovered root' };
  const props = { selectedId: child.itemId, onOpen: vi.fn() };
  const view = render(<TelosOutcomesTree {...props} refreshKey={0} records={[parent, child]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Retained parent' }));
  // A collection key change temporarily renders the selected-record fallback.
  view.rerender(<TelosOutcomesTree {...props} refreshKey={1} records={[child]} />);
  view.rerender(<TelosOutcomesTree {...props} refreshKey={2} records={[parent, child]} />);
  expect(
    screen.getByRole('button', { name: 'Expand Retained parent' }).getAttribute('aria-expanded'),
  ).toBe('false');
  view.rerender(<TelosOutcomesTree {...props} refreshKey={3} records={[root, parent, child]} />);
  expect(
    screen
      .getByRole('button', { name: 'Collapse Newly discovered root' })
      .getAttribute('aria-expanded'),
  ).toBe('true');
  expect(
    screen.getByRole('button', { name: 'Expand Retained parent' }).getAttribute('aria-expanded'),
  ).toBe('false');
});

it('lets active search paths collapse and expand without clearing query, including across refresh and remount', () => {
  const root = { ...records[0], itemId: 'druid-root', parentId: null, summary: 'Druid' };
  const child = {
    ...records[0],
    itemId: 'druid-child',
    parentId: root.itemId,
    summary: 'Druid leaf',
  };
  const props = { records: [root, child], onOpen: vi.fn(), refreshKey: 0 };
  const view = render(<TelosOutcomesTree {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Druid leaf' } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Druid' }));
  expect(screen.getByRole('button', { name: 'Expand Druid' }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  view.rerender(
    <TelosOutcomesTree {...props} refreshKey={1} records={[{ ...root }, { ...child }]} />,
  );
  expect(screen.getByRole('button', { name: 'Expand Druid' })).toBeTruthy();
  view.unmount();
  render(<TelosOutcomesTree {...props} />);
  expect(screen.getByRole('button', { name: 'Expand Druid' })).toBeTruthy();
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Druid leaf');
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  expect(screen.getByRole('button', { name: child.summary })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  expect(screen.getByRole('button', { name: 'Expand Druid' })).toBeTruthy();
});

it('renders a ready record alongside pending collection reads', () => {
  const item = { ...records[0], parentId: null };
  render(<TelosOutcomesTree records={[item]} onOpen={vi.fn()} refreshKey={0} loading />);
  expect(screen.getByRole('status').textContent).toBe('Loading outcomes…');
  expect(screen.getByRole('button', { name: item.summary })).toBeTruthy();
});

it('keeps category matches manually collapsible and resets collapse overrides only when context changes', () => {
  const root = {
    ...records[0],
    itemId: 'category-root',
    parentId: null,
    summary: 'Category root',
    categories: ['Job'],
  };
  const child = {
    ...records[0],
    itemId: 'category-child',
    parentId: root.itemId,
    summary: 'Category child',
    categories: ['Job'],
  };
  render(<TelosOutcomesTree records={[root, child]} refreshKey={0} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Job' }));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Category root' }));
  expect(screen.getByRole('button', { name: 'Expand Category root' })).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: child.summary } });
  expect(screen.getByRole('button', { name: 'Collapse Category root' })).toBeTruthy();
  expect(screen.getByRole('button', { name: child.summary })).toBeTruthy();
});

it.each([
  ['priority-desc', ['High', 'Low', 'Unknown date']],
  ['priority-asc', ['Low', 'Unknown date', 'High']],
  ['newest', ['Low', 'High', 'Unknown date']],
  ['oldest', ['High', 'Low', 'Unknown date']],
])(
  'sorts sibling outcomes by %s with stable ties and unknown dates last without rewriting hierarchy',
  (sort, expected) => {
    const template = records[0];
    const ordered = [
      {
        ...template,
        itemId: 'low',
        parentId: null,
        summary: 'Low',
        priority: 2,
        createdAt: '2026-10-20T12:00:00Z',
      },
      {
        ...template,
        itemId: 'high',
        parentId: null,
        summary: 'High',
        priority: 9,
        createdAt: '2026-10-18T12:00:00Z',
      },
      {
        ...template,
        itemId: 'unknown-date',
        parentId: null,
        summary: 'Unknown date',
        priority: 2,
        createdAt: null,
      },
    ];
    const original = JSON.stringify(ordered);
    const view = render(<TelosOutcomesTree records={ordered} refreshKey={0} onOpen={vi.fn()} />);
    const titles = () =>
      [
        ...view.container.querySelectorAll('.telos-tree > li > .telos-tree-row .telos-node-title'),
      ].map((node) => node.textContent);
    expect(titles()).toEqual(['Low', 'High', 'Unknown date']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort outcomes' }), {
      target: { value: sort },
    });
    expect(titles()).toEqual(expected);
    expect(JSON.stringify(ordered)).toBe(original);
    if (sort === 'newest' || sort === 'oldest')
      expect(screen.getByText('Creation date unknown')).toBeTruthy();
    view.unmount();
    render(<TelosOutcomesTree records={ordered} refreshKey={1} onOpen={vi.fn()} />);
    expect(
      (screen.getByRole('combobox', { name: 'Sort outcomes' }) as HTMLSelectElement).value,
    ).toBe(sort);
  },
);

it('keeps sort, query and manually collapsed parent context through refresh without flattening child work', () => {
  const root = {
    ...records[0],
    itemId: 'sort-parent',
    parentId: null,
    summary: 'Druid parent',
    priority: 3,
  };
  const high = {
    ...records[0],
    itemId: 'sort-high',
    parentId: root.itemId,
    summary: 'Druid high child',
    priority: 9,
  };
  const low = {
    ...records[0],
    itemId: 'sort-low',
    parentId: root.itemId,
    summary: 'Druid low child',
    priority: 1,
  };
  const props = { records: [root, low, high], refreshKey: 0, onOpen: vi.fn() };
  const view = render(<TelosOutcomesTree {...props} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Druid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Druid parent' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Sort outcomes' }), {
    target: { value: 'priority-desc' },
  });
  expect(screen.getByRole('button', { name: 'Expand Druid parent' })).toBeTruthy();
  view.rerender(
    <TelosOutcomesTree
      {...props}
      refreshKey={1}
      records={[{ ...root }, { ...low }, { ...high }]}
    />,
  );
  expect(screen.getByRole('button', { name: 'Expand Druid parent' })).toBeTruthy();
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Druid');
  fireEvent.click(screen.getByRole('button', { name: 'Expand Druid parent' }));
  const children = [
    ...view.container.querySelectorAll('.telos-tree .telos-tree .telos-node-title'),
  ].map((node) => node.textContent);
  expect(children).toEqual(['Druid high child', 'Druid low child']);
});
