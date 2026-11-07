// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import { CollaborationJoinSchema, COLLABORATION_EXECUTION_DISABLED } from '@mitzo/protocol';
import { SharedConversationHost, SharedConversationBody } from '../SharedConversation';
import {
  sharedConversationView,
  settings,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('mounts the retained shared transcript through the production wrapper while preserving ordinary history', async () => {
  const view = sharedConversationView();
  view.joinedParticipants = [{ sessionId: 'reviewer', name: 'Reviewer' }];
  view.joins.push(
    CollaborationJoinSchema.parse({
      version: 1,
      joinId: uuid(100),
      name: 'Reviewer',
      membershipRevision: 1,
      settings,
      snapshot: { snapshotId: uuid(101), sha256: 'a'.repeat(64) },
      allocationOperationId: uuid(102),
      state: 'linked',
      sessionId: 'reviewer',
      linkedFromRevision: 1,
      execution: COLLABORATION_EXECUTION_DISABLED,
    }),
  );
  const fetch = vi.fn(async (url: string) => {
    if (url.includes('source-setup'))
      return Response.json({
        state: 'selected',
        sourceConversationId: 'architect',
        collaboration: {
          version: 1,
          collaborationId: view.collaborationId,
          revision: view.membershipRevision,
          participantSessionIds: view.participantSessionIds,
        },
      });
    if (url.endsWith('/conversation')) return Response.json(view);
    throw Error('Unexpected read: ' + url);
  });
  const proof = () => 'login';
  render(
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={new MitzoApiClient(fetch)}
        clientId="client"
        authScope="login"
        getVerifiedAuthScope={proof}
      >
        <SharedConversationBody
          sourceConversationId="architect"
          chat={{
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
        >
          <p>Original ordinary history</p>
        </SharedConversationBody>
      </SharedConversationHost>
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Choose who replies' })).toBeTruthy(),
  );
  expect(screen.getByText('Original ordinary history')).toBeTruthy();
  expect(fetch.mock.calls.some(([url]) => url.endsWith('/messages'))).toBe(false);
});
