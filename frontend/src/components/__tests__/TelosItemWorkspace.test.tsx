// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  expect(screen.getByRole('button', { name: 'Work', exact: true })).toBeTruthy();
  expect(screen.getByText('Created')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Work', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: records[1].summary, exact: true }));
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
  expect(screen.queryByRole('button', { name: 'Work', exact: true })).toBeNull();
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Materials', exact: true }));
  expect(screen.getByText('Retained output revisions')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Links', exact: true })).toBeTruthy();
  expect(screen.getByRole('link', { name: /External reference/ }).getAttribute('href')).toBe(
    'https://example.com',
  );
  expect(screen.getByRole('button', { name: /Pinned brief/ })).toBeTruthy();
});
it('does not turn legacy session hints into assignments and preserves selected tab on reload', () => {
  const record = records[0];
  const view = render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={records} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Chat', exact: true }));
  expect(screen.getByText('Ordinary role entry')).toBeTruthy();
  view.unmount();
  render(
    <MemoryRouter>
      <TelosItemWorkspace record={record} records={records} onOpen={vi.fn()} onBack={vi.fn()} />
    </MemoryRouter>,
  );
  expect(
    screen.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed'),
  ).toBe('true');
});
