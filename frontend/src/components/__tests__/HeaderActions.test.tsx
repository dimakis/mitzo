// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MobileShell } from '../MobileShell';
import { ConversationAgents } from '../ConversationAgents';

vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: () => false }));
afterEach(cleanup);

it('focuses the existing Chats search field from the masthead without losing its query', () => {
  render(
    <MemoryRouter initialEntries={['/sessions']}>
      <MobileShell>
        <input
          id="conversation-search"
          type="search"
          aria-label="Search conversations"
          defaultValue="retained query"
        />
      </MobileShell>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Search chats' }));
  const input = screen.getByRole('searchbox', { name: 'Search conversations' }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('retained query');
});

it('keeps Symposium available as one robot icon rather than a text menu or linked-chat control', () => {
  const { container } = render(
    <MemoryRouter>
      <ConversationAgents
        compact
        scope="chat"
        messages={[]}
        agents={[
          { id: 'main', name: 'Mitzo', state: 'Current conversation' },
          { id: 'review', name: 'Reviewer', state: 'Added' },
        ]}
      />
    </MemoryRouter>,
  );
  const entry = screen.getByRole('button', { name: 'Agents, Mitzo, Reviewer' });
  expect(entry.textContent).toBe('');
  expect(entry.querySelector('[data-icon="bot"]')).not.toBeNull();
  expect(container.querySelector('.conversation-agents-entry')).not.toBeNull();
});
