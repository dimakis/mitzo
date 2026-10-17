// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentLibraryChatLink, AgentLibrarySourceContext } from '../AgentLibraryChatSource';
import { newAgentDefinition } from '../../lib/agent-library';
import type { SourceSnapshot } from '@mitzo/protocol';
afterEach(cleanup);
const source: SourceSnapshot = {
  kind: 'agent-library',
  revision: 'a'.repeat(64),
  content: JSON.stringify({
    version: 1,
    source: {
      kind: 'draft',
      profileId: 'bob',
      baseRevision: 3,
      draftVersion: null,
      expectedVersion: 2,
    },
    definition: {
      ...newAgentDefinition(),
      name: 'Working Bob',
      instructions: 'Review **assumptions**.',
      tools: [{ id: 'mitzo:read', version: 1 }],
    },
  }),
};
it('shows the retained profile in shared Resources as readable guidance and provenance', () => {
  render(<AgentLibrarySourceContext sources={[source]} />);
  fireEvent.click(screen.getByRole('button', { name: /Agent Library context/ }));
  expect(screen.getByRole('heading', { name: 'Instructions' })).toBeTruthy();
  expect(
    screen.getByText('assumptions', { exact: false }).querySelector('strong') ??
      screen.getByText('assumptions'),
  ).toBeTruthy();
  expect(screen.getByText('mitzo:read')).toBeTruthy();
  expect(screen.getByText('Unsaved draft · based on r3 · bob')).toBeTruthy();
  expect(screen.queryByText('"version": 1', { exact: false })).toBeNull();
});
it('contains damaged retained content without crashing the ordinary chat', () => {
  render(<AgentLibrarySourceContext sources={[{ ...source, content: '{damaged' }]} />);
  expect(screen.getByRole('alert').textContent).toBe('Agent Library context unavailable.');
});
it('offers the existing Library route without changing ordinary session controls', () => {
  render(
    <MemoryRouter>
      <AgentLibraryChatLink sources={[source]} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Open Agent Library' }).getAttribute('href')).toBe(
    '/agent-library',
  );
});
