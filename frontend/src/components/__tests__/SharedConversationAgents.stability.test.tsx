// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import { SharedConversationAgents, SharedConversationHost } from '../SharedConversation';
import { ComposerStatusProvider, ComposerStatusRail } from '../ComposerStatus';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';
import type { SessionActivity } from '@mitzo/protocol';

const observed = vi.hoisted(() => ({ activities: [] as SessionActivity[], connected: true }));
vi.mock('../../hooks/useSessionOverview', () => ({
  useSessionOverview: () => ({ ...observed, lastKnownActivities: [] }),
}));
vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  observed.activities = [];
  observed.connected = true;
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
const proof = () => 'roster-login';

it('opens the same Agents owner from status and header, retains rows/configuration through broadcasts, and isolates recipients', async () => {
  const view = sharedConversationView();
  view.joinedParticipants = [
    { sessionId: 'reviewer', name: 'Reviewer' },
    { sessionId: 'reader', name: 'Reader' },
  ];
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('source-setup'))
      return Response.json({
        state: 'selected',
        sourceConversationId: 'architect',
        collaboration: {
          version: 1,
          collaborationId: view.collaborationId,
          revision: 1,
          participantSessionIds: view.participantSessionIds,
        },
      });
    if (url.endsWith('/conversation')) return Response.json(view);
    if (url.endsWith('/progress'))
      return Response.json({
        collaborationId: view.collaborationId,
        membershipRevision: 1,
        replies: [],
        refusals: [],
      });
    throw Error('Unexpected request: ' + url);
  });
  const api = new MitzoApiClient(fetch);
  const recipients = vi.fn();
  const tree = () => (
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={api}
        clientId="client"
        authScope={proof()}
        getVerifiedAuthScope={proof}
      >
        <SharedConversationAgents
          scope="architect"
          agents={[{ id: 'architect', name: 'Architect', state: 'Current conversation' }]}
          messages={[]}
        />
        <ComposerStatusProvider>
          <ComposerStatusRail
            sessionId="architect"
            recipients="To Reviewer"
            onRecipientsClick={recipients}
          />
        </ComposerStatusProvider>
        <textarea aria-label="Draft" defaultValue="Preserve this draft" />
      </SharedConversationHost>
    </MemoryRouter>
  );
  const result = render(tree());
  const status = await screen.findByRole('button', { name: /^Open Agents,/ });
  status.focus();
  fireEvent.click(status);
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  const details = screen.getByRole('button', { name: 'Details for Reviewer' });
  details.focus();
  const row = details.closest('article');
  observed.activities = [
    {
      sessionId: 'reviewer',
      clientId: 'reviewer-client',
      title: 'Reviewer',
      state: 'working',
      flags: [],
      lastEventAt: 10,
      phase: 'reading',
    },
  ];
  result.rerender(tree());
  expect(screen.getByRole('button', { name: 'Details for Reviewer' })).toBe(details);
  expect(details.closest('article')).toBe(row);
  expect(document.activeElement).toBe(details);
  fireEvent.click(details);
  expect(within(screen.getByRole('dialog')).getByText('offline-fixture')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).getByText('agent')).toBeTruthy();
  observed.connected = false;
  observed.activities = [];
  result.rerender(tree());
  expect(within(screen.getByRole('dialog')).getByText('offline-fixture')).toBeTruthy();
  expect(screen.getByText(/Activity is disconnected/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(status);
  fireEvent.click(screen.getByRole('button', { name: 'To Reviewer' }));
  expect(recipients).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect, Reviewer, Reader' }));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Details for Reviewer' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty(
    'value',
    'Preserve this draft',
  );
  await act(async () => {});
  expect(fetch.mock.calls.every(([url]) => !/send|stop|review|join/.test(url))).toBe(true);
});
