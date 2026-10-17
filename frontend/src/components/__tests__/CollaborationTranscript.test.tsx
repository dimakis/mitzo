// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createCollaborationProjection, applyCollaborationEvents } from '@mitzo/client';
import { CollaborationTranscript } from '../CollaborationTranscript';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const names = { architect: 'Architect', reviewer: 'Reviewer', reader: 'Reader' };
it('keeps the successful reply visible beside uncertain and pending independent recipients', () => {
  const projection = createCollaborationProjection(sharedConversationView());
  const { rerender } = render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} />
    </MemoryRouter>,
  );
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
  fireEvent.click(screen.getByText('To Architect, Reviewer · Context for Reader'));
  expect(screen.getByText('Prompt accepted')).toBeTruthy();
  expect(screen.getByText('Outcome uncertain · do not resend')).toBeTruthy();
  expect(screen.getByText('Context pending · no response requested')).toBeTruthy();
  const receipt = screen
    .getByText('To Architect, Reviewer · Context for Reader')
    .closest('details')!;
  const refused = applyCollaborationEvents(projection, {
    events: [],
    cursor: 99,
    highWatermark: 99,
    hasMore: false,
  });
  rerender(
    <MemoryRouter>
      <CollaborationTranscript projection={refused} names={names} />
    </MemoryRouter>,
  );
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
  expect(screen.getByText('To Architect, Reviewer · Context for Reader').closest('details')).toBe(
    receipt,
  );
  expect(receipt.open).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('Refresh');
  expect(screen.queryByRole('button', { name: /retry|resend/i })).toBeNull();
});
it('uses the actual source session and frozen prompt settings, without current account substitutions', () => {
  const view = sharedConversationView();
  const onRefresh = vi.fn();
  const projection = createCollaborationProjection(view);
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} onRefresh={onRefresh} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText('Message details for Architect'));
  expect(screen.getByText('Session architect')).toBeTruthy();
  expect(screen.getByText('same-offline-account · offline-fixture')).toBeTruthy();
  expect(onRefresh).not.toHaveBeenCalled();
});
it('projects replayed recipient failures without deleting another recipient reply', () => {
  const projection = applyCollaborationEvents(
    createCollaborationProjection(sharedConversationView()),
    {
      events: [
        {
          version: 1,
          collaborationId: uuid(1),
          eventId: uuid(30),
          sequence: 3,
          change: {
            kind: 'delivery',
            messageId: sharedPrompt.messageId,
            delivery: {
              ...sharedPrompt.deliveries[1],
              revision: 2,
              status: 'failed',
              reason: 'Definite refusal',
            },
          },
        },
      ],
      cursor: 3,
      highWatermark: 3,
      hasMore: false,
    },
  );
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={projection} names={names} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('To Architect, Reviewer · Context for Reader'));
  expect(screen.getByText('Prompt failed')).toBeTruthy();
  expect(screen.getByText('Definite refusal')).toBeTruthy();
  expect(screen.getByText(sharedReply.text)).toBeTruthy();
});

it('opens the existing Markdown preview through its author session API scope', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ path: 'plan.md', content: 'Retained source preview' }), {
      status: 200,
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const view = sharedConversationView();
  view.messages[1].text = '[Plan](/workspace/plan.md)';
  render(
    <MemoryRouter>
      <CollaborationTranscript projection={createCollaborationProjection(view)} names={names} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /MD.*plan.md/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const url = new URL(fetch.mock.calls[0][0], 'http://offline.test');
  expect(url.pathname).toBe('/api/files/read');
  expect(url.searchParams.get('sessionId')).toBe('architect');
  expect(await screen.findByText('Retained source preview')).toBeTruthy();
});
