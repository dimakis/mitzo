// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentToolCatalogEntry } from '@mitzo/protocol';
import { ToolLibraryCatalog } from '../ToolLibraryCatalog';

function Catalog(
  props: Pick<ComponentProps<typeof ToolLibraryCatalog>, 'tools' | 'catalog' | 'loaded'>,
) {
  const [filters, setFilters] = useState({ query: '', source: '' });
  return <ToolLibraryCatalog {...props} filters={filters} onFiltersChange={setFilters} />;
}

afterEach(cleanup);
const tools: AgentToolCatalogEntry[] = [
  {
    id: 'mitzo:Read',
    version: 1,
    name: 'Read',
    description: 'Read workspace files.',
    source: 'Workspace',
    required: false,
    behavior: 'read',
    routes: ['local-api'],
    requirement: 'Workspace permissions apply.',
  },
  {
    id: 'mitzo:Find',
    version: 1,
    name: 'Find',
    description: 'Find workspace evidence.',
    source: 'Web',
    required: false,
    behavior: 'read',
    routes: [],
    requirement: 'Explicit selection is unsupported.',
  },
];
it('combines category and text filters, reports results and recovers from no matches', () => {
  render(<Catalog tools={tools} catalog={null} loaded />);
  expect(screen.getByText('2 tools')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Workspace' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Find' } });
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  expect(screen.getByText('No matching tools')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
});
it('keeps full requirements and profile references in closed details and distinguishes unsupported routes', () => {
  render(<Catalog tools={tools} catalog={{ drafts: [], versions: [] }} loaded />);
  const read = screen.getAllByRole('article')[0];
  const details = read.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(within(details).getByText('Workspace permissions apply.')).toBeTruthy();
  expect(within(details).getByText(/No explicit references/)).toBeTruthy();
  expect(screen.getByText('Selection unavailable')).toBeTruthy();
  expect(within(read).getByText('Read only')).toBeTruthy();
});
it('does not claim empty tools or unused profiles while data is unavailable', () => {
  const { rerender } = render(<Catalog tools={[]} catalog={null} loaded={false} />);
  expect(screen.queryByText('No implemented tools are available.')).toBeNull();
  rerender(<Catalog tools={tools} catalog={null} loaded />);
  expect(screen.queryByText(/No explicit references/)).toBeNull();
  rerender(<Catalog tools={[]} catalog={null} loaded />);
  expect(screen.getByText('No implemented tools are available.')).toBeTruthy();
});
