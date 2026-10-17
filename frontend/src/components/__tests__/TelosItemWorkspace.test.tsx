// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosItemWorkspace } from '../TelosItemWorkspace';
vi.mock('../TelosItemRoleEntries', () => ({
  TelosItemRoleEntries: () => <div>Ordinary role entry</div>,
}));
vi.mock('../WorkOutputs', () => ({ WorkOutputs: () => <div>Retained output revisions</div> }));
vi.mock('../TelosItemSources', () => ({
  TelosItemSources: () => <div>Retained source exchange</div>,
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
const records = createTelosWorkFixtures().homeStudio.items;
it('retains the brief, original fields, exact dates, context and parent-only Work entry', () => {
  const onOpen = vi.fn();
  render(
    <MemoryRouter>
      <TelosItemWorkspace record={records[0]} records={records} onOpen={onOpen} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  expect(screen.getByText(records[0].rationale)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Work' })).toBeTruthy();
  expect(screen.getByText('Created')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Work' }));
  fireEvent.click(screen.getByRole('button', { name: records[1].summary }));
  expect(onOpen).toHaveBeenCalledWith(records[1].itemId);
});
it('separates materials, source references and external links with unknown dates kept unknown', () => {
  const record = {
    ...records[1],
    createdAt: null,
    updatedAt: null,
    links: [
      {
        type: 'artifact',
        url: '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=2',
        title: 'Pinned brief',
        description: 'r2',
        addedAt: null,
      },
      {
        type: 'external',
        url: 'https://example.com',
        title: 'External reference',
        description: 'original link',
        addedAt: null,
      },
    ],
  };
  render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={[record]} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('button', { name: 'Work' })).toBeNull();
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Materials' }));
  expect(screen.getByText('Retained output revisions')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Links' })).toBeTruthy();
  expect(screen.getByRole('link', { name: /External reference/ }).getAttribute('href')).toBe(
    'https://example.com',
  );
  expect(screen.getByRole('link', { name: /Pinned brief/ })).toBeTruthy();
});
it('does not turn legacy session hints into assignments and preserves selected tab on reload', () => {
  const record = records[0];
  const view = render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={records} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
  expect(screen.getByText('Ordinary role entry')).toBeTruthy();
  view.unmount();
  render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={records} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true');
});

it('does not claim empty child work when the collection boundary is loading or unavailable', () => {
  const record = records[0];
  const view = render(
    <MemoryRouter>
      <TelosItemWorkspace
        record={record}
        records={[record]}
        relatedState="loading"
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Loading child work…')).toBeTruthy();
  expect(screen.queryByText('No child work yet.')).toBeNull();
  view.rerender(
    <MemoryRouter>
      <TelosItemWorkspace
        record={record}
        records={[record]}
        relatedState="unavailable"
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(
    screen.getByText('Child work unavailable. Refresh to check its current state.'),
  ).toBeTruthy();
  expect(screen.queryByText('No child work yet.')).toBeNull();
});

it('offers an explicit retry for unavailable child work', () => {
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <TelosItemWorkspace
        record={records[0]}
        records={[records[0]]}
        relatedState="unavailable"
        onRefresh={refresh}
        onOpen={vi.fn()}
        onBack={vi.fn()}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it('keeps Context collapsed with readable populated labels from the approved brief', () => {
  const record = {
    ...records[0],
    contextHints: {
      ...records[0].contextHints,
      repos: ['fixture/repo'],
      paths: ['plan.md'],
      people: ['Fixture partner'],
      keywords: ['Audio'],
    },
  };
  render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={[record]} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  const summary = screen.getByText('Context', { selector: 'summary' });
  const context = summary.closest('details')!;
  expect(context.hasAttribute('open')).toBe(false);
  expect(within(context).getByText('Repositories')).toBeTruthy();
  expect(within(context).getByText('Files')).toBeTruthy();
  expect(within(context).getByText('People')).toBeTruthy();
  expect(within(context).queryByText('repos')).toBeNull();
  expect(within(context).queryByText('Not recorded')).toBeNull();
  expect(within(context).queryByText('Issues')).toBeNull();
});

it('preserves real child work for an unclassified legacy parent without assigning its kind', () => {
  const parent = { ...records[0], kind: null };
  const open = vi.fn();
  render(
    <MemoryRouter>
      <TelosItemWorkspace
        record={parent}
        records={[parent, records[1]]}
        onOpen={open}
        onBack={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Unclassified · active')).toBeTruthy();
  expect(screen.queryByText('This work item')).toBeNull();
  expect(screen.getByRole('button', { name: records[1].summary })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Work' }));
  fireEvent.click(screen.getByRole('button', { name: records[1].summary }));
  expect(open).toHaveBeenCalledWith(records[1].itemId);
  expect(parent.kind).toBeNull();
});
