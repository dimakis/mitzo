// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { CollaborationSourceCatalog } from '@mitzo/protocol';
import { ConversationAgents } from '../ConversationAgents';
import { useConversationJoiningCatalog } from '../../hooks/useConversationJoiningCatalog';
import type { LegacyConversationJoiningOwner } from '../../lib/conversation-joining-review';
import {
  retainedArtifact,
  retainedPin,
} from '../../lib/__tests__/conversation-joining-retained-fixture';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import * as auth from '../../lib/api-fetch';

vi.mock('../AccountModelPicker', () => ({
  AccountModelPicker: ({
    onDraftSelectionChange,
  }: {
    onDraftSelectionChange(value: unknown): void;
  }) => (
    <button type="button" onClick={() => onDraftSelectionChange(joiningSetupFixture().selection)}>
      Choose offline account
    </button>
  ),
}));
vi.mock('../ChatAgentProfilePicker', () => ({
  ChatAgentProfilePicker: ({ onChange }: { onChange(value: unknown): void }) => (
    <button type="button" onClick={() => onChange(joiningSetupFixture().agent)}>
      Choose offline agent
    </button>
  ),
}));
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'catalog-ui-login' })),
  );
  await auth.restoreCookieAuthentication();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount({ failInitial = false } = {}) {
  let revision = 2;
  let refuseMore = false;
  const review = vi.fn<LegacyConversationJoiningOwner['review']>(async () => {
    throw Error('No production review in this selector test');
  });
  const owner: LegacyConversationJoiningOwner = {
    sourceConversationId: 'source-chat',
    review,
    confirm: vi.fn(),
    recover: vi.fn(),
  };
  const catalog = (): CollaborationSourceCatalog => ({
    sourceConversationId: 'source-chat',
    boundary: joiningReviewFixture().snapshot.boundary,
    messages: joiningReviewFixture().snapshot.messages,
    artifacts: [
      {
        ...retainedArtifact,
        revision,
        sha256: revision === 2 ? retainedArtifact.sha256 : 'c'.repeat(64),
        title: revision === 2 ? retainedArtifact.title : 'New r3 plan',
        filename: revision === 2 ? retainedArtifact.filename : 'new-r3.md',
      },
    ],
    artifactCursor: { createdAt: '2026-10-20', artifactId: 'plan', revision },
    artifactHasMore: true,
    retainedAvailability: 'available',
    unversionedRetainedReferences: false,
    sourceRepository: { repository: 'dimakis/mitzo' },
  });
  const transport = vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'https://offline.invalid').pathname;
    if (path === '/api/auth/check')
      return Response.json({ ok: true, authSessionId: 'catalog-ui-login' });
    const body = JSON.parse(init!.body as string);
    expect(body.clientId).toBe('live-client');
    if (path === '/api/session-collaborations/source-artifact-versions') {
      expect(body.artifact).toEqual(retainedPin());
      return Response.json({
        sourceConversationId: 'source-chat',
        boundary: catalog().boundary,
        artifacts: [
          { ...retainedArtifact, revision: 1, sha256: 'a'.repeat(64), filename: 'earlier-r1.md' },
        ],
        cursor: null,
        hasMore: false,
      });
    }
    expect(path).toBe('/api/session-collaborations/source-catalog');
    if (failInitial && !body.artifactsAfter)
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    if (body.artifactsAfter && refuseMore)
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    return Response.json(catalog());
  });
  vi.stubGlobal('fetch', transport);
  function Body() {
    const data = useConversationJoiningCatalog({
      sourceConversationId: 'source-chat',
      clientId: 'live-client',
    });
    return (
      <MemoryRouter>
        <ConversationAgents
          scope="source-chat"
          joiningCatalog={data}
          joiningOwner={owner}
          agents={[{ id: 'source-chat', name: 'Mitzo', state: 'Current conversation' }]}
          messages={[
            {
              messageId: 'unfinished-local',
              role: 'assistant',
              blocks: [
                {
                  blockId: 'unfinished-block',
                  blockType: 'text',
                  content: 'Unfinished local response',
                },
              ],
            },
          ]}
        />
      </MemoryRouter>
    );
  }
  render(<Body />);
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Mitzo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Reviewer' },
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Purpose' }), {
    target: { value: 'Keep exact saved versions.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Choose offline account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Choose offline agent' }));
  return {
    review,
    transport,
    newer: () => {
      revision = 3;
    },
    refuseMore: () => {
      refuseMore = true;
    },
  };
}

it('uses durable catalog messages and explicit exact history while preserving draft, footer and keyboard focus', async () => {
  const h = mount();
  await screen.findByRole('checkbox', { name: /retained-plan-r2.md/ });
  expect(screen.queryByRole('checkbox', { name: /Unfinished local response/ })).toBeNull();
  expect(
    screen.getByRole('checkbox', { name: /Keep the plan and the discussion together/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /retained-plan-r2.md/ }));
  const history = screen.getByRole('button', { name: /Earlier saved versions/ });
  history.focus();
  fireEvent.click(history);
  await screen.findByRole('checkbox', { name: /earlier-r1.md/ });
  expect(
    (screen.getByRole('checkbox', { name: /retained-plan-r2.md/ }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('status'));
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Keep exact saved versions.',
  );
  expect(
    screen.getByRole('button', { name: 'Review joining brief' }).closest('footer'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review joining brief' }));
  await waitFor(() => expect(h.review).toHaveBeenCalledTimes(1));
  expect(h.review.mock.calls[0][0].setup.artifacts).toEqual([retainedPin()]);
  expect(h.review.mock.calls[0][0].setup.messageIds).toEqual([]);
});

it('keeps the selected r2 label and pin when refresh supplies r3, then clears private labels on auth retirement', async () => {
  const h = mount();
  await screen.findByRole('checkbox', { name: /retained-plan-r2.md/ });
  fireEvent.click(screen.getByRole('checkbox', { name: /retained-plan-r2.md/ }));
  h.refuseMore();
  fireEvent.click(screen.getByRole('button', { name: 'More saved artifacts' }));
  await screen.findByRole('button', { name: 'Check saved context again' });
  h.newer();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved context again' }));
  await screen.findByRole('checkbox', { name: /new-r3.md/ });
  expect(
    (screen.getByRole('checkbox', { name: /retained-plan-r2.md/ }) as HTMLInputElement).checked,
  ).toBe(true);
  expect((screen.getByRole('checkbox', { name: /new-r3.md/ }) as HTMLInputElement).checked).toBe(
    false,
  );
  await act(async () => {
    auth.markAuthLost();
    await auth.restoreCookieAuthentication();
  });
  await screen.findByRole('checkbox', { name: /new-r3.md/ });
  expect(screen.queryByRole('checkbox', { name: /retained-plan-r2.md/ })).toBeNull();
});

it('keeps read failure distinct from empty context without clearing the editable draft', async () => {
  mount({ failInitial: true });
  await screen.findByRole('button', { name: 'Check saved context again' });
  expect(screen.queryByText('No messages yet.')).toBeNull();
  expect(screen.queryByText('No artifacts in this conversation.')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Purpose' }) as HTMLInputElement).value).toBe(
    'Keep exact saved versions.',
  );
});
