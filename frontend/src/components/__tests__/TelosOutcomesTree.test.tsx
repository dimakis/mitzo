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
