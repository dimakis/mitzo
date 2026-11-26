// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import { SharedConversationHost, SharedConversationAgents } from '../SharedConversation';
import type { ConversationJoiningOwner } from '../../lib/conversation-joining-review';
import { sharedConversationView } from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { installDialogStub } from './dialog-stub';
import { markAuthLost, restoreCookieAuthentication } from '../../lib/api-fetch';

const observed = vi.hoisted(() => ({ owner: undefined as ConversationJoiningOwner | undefined }));
vi.mock('@mitzo/client/hooks', () => ({
  useMitzoStore: (select: (state: unknown) => unknown) => select({ connection: null }),
}));
// Observe the host's real owner while preserving the actual consumer and selector.
vi.mock('../ConversationAgents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ConversationAgents')>();
  return {
    ...actual,
    ConversationAgents: (props: Parameters<typeof actual.ConversationAgents>[0]) => {
      observed.owner = props.joiningOwner;
      return <actual.ConversationAgents {...props} />;
    },
  };
});
vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
vi.mock('../ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
vi.mock('../ConversationRepositoryPicker', () => ({ ConversationRepositoryPicker: () => null }));

beforeEach(async () => {
  // External SSE transport only; host, source adapter and consumer stay real.
  vi.stubGlobal(
    'EventSource',
    class extends EventTarget {
      readyState = 1;
      close() {
        this.readyState = 2;
      }
    },
  );
  localStorage.clear();
  sessionStorage.clear();
  markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'catalog-host-login' })),
  );
  await restoreCookieAuthentication();
  installDialogStub();
  observed.owner = undefined;
});
afterEach(() => {
  cleanup();
  markAuthLost();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const proof = () => 'catalog-host-login';
const pin = { artifactId: 'retained-plan', revision: 4, sha256: 'c'.repeat(64) };
function mount(state: 'unstarted' | 'selected') {
  const view = sharedConversationView();
  view.messages = [];
  view.cursor = 0;
  view.participantSessionIds = ['architect'];
  view.policies = view.policies.filter((policy) => policy.sessionId === 'architect');
  const unexpected: string[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'GET') {
      unexpected.push(`${init?.method} ${url}`);
      throw Error('Inspection unexpectedly attempted a mutation');
    }
    if (url.includes('/source-setup'))
      return Response.json(
        state === 'unstarted'
          ? { state, sourceConversationId: 'architect' }
          : {
              state,
              sourceConversationId: 'architect',
              collaboration: {
                version: 1,
                collaborationId: view.collaborationId,
                revision: view.membershipRevision,
                participantSessionIds: view.participantSessionIds,
              },
            },
      );
    if (url.endsWith('/conversation')) return Response.json(view);
    if (url.endsWith('/recipients/architect'))
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: 'architect',
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready: false,
        reason: 'Offline catalog fixture',
      });
    if (url.endsWith('/progress'))
      return Response.json({
        collaborationId: view.collaborationId,
        membershipRevision: view.membershipRevision,
        replies: [],
        refusals: [],
      });
    if (url.includes('/events'))
      return Response.json({ events: [], cursor: 0, highWatermark: 0, hasMore: false });
    if (url.includes('/context-source-artifacts'))
      return Response.json({
        sourceConversationId: 'architect',
        artifacts: [{ ...pin, title: 'Retained architecture plan', available: true }],
      });
    unexpected.push(`GET ${url}`);
    throw Error('Unexpected read: ' + url);
  });
  render(
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId="architect"
        api={new MitzoApiClient(request)}
        clientId="catalog-client"
        authScope={proof()}
        getVerifiedAuthScope={proof}
      >
        <SharedConversationAgents
          scope="architect"
          agents={[{ id: 'architect', name: 'Architect', state: 'Ready' }]}
          messages={[
            {
              messageId: 'ordinary-plan',
              role: 'assistant',
              timestamp: 1_800_000_000_000,
              blocks: [
                {
                  blockId: 'plan-text',
                  blockType: 'text',
                  content: '**Ordinary plan** stays available before sharing.',
                },
              ],
            },
          ]}
        />
      </SharedConversationHost>
    </MemoryRouter>,
  );
  return { request, unexpected };
}

async function openSelectedContext() {
  await waitFor(() => expect(observed.owner?.kind).toBe('application'));
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  fireEvent.click(screen.getByRole('button', { name: /Starting context,/ }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Context' }), {
    target: { value: 'selected' },
  });
}

it('keeps an unbegun host catalog unavailable without beginning sharing when selecting or previewing messages', async () => {
  const { request, unexpected } = mount('unstarted');
  await openSelectedContext();
  expect(observed.owner?.loadArtifacts).toBeUndefined();
  expect(
    screen.getByText(
      /Retained artifacts are unavailable until this conversation has an existing shared association/,
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry artifact list' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: /Architect Message.*Ordinary plan/ }));
  fireEvent.click(screen.getByText('Preview message from Architect', { selector: 'summary' }));
  await screen.findByText('Ordinary plan', { selector: 'strong' });
  expect(screen.getByText('1 messages · 0 artifacts selected')).toBeTruthy();
  expect(request.mock.calls.some(([url]) => url.includes('/context-source-artifacts'))).toBe(false);
  expect(request.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  expect(unexpected).toEqual([]);
});

it('loads exact retained metadata from an existing host association only after explicit selector inspection', async () => {
  const { request, unexpected } = mount('selected');
  await waitFor(() => expect(observed.owner?.loadArtifacts).toBeTypeOf('function'));
  expect(observed.owner?.artifactsUnavailableReason).toBeUndefined();
  expect(request.mock.calls.some(([url]) => url.includes('/context-source-artifacts'))).toBe(false);
  await openSelectedContext();
  const choice = await screen.findByRole('checkbox', {
    name: /Retained architecture plan.*Saved version 4/,
  });
  expect((choice as HTMLInputElement).checked).toBe(false);
  fireEvent.click(choice);
  expect((choice as HTMLInputElement).checked).toBe(true);
  const catalogCalls = request.mock.calls.filter(([url]) =>
    url.includes('/context-source-artifacts'),
  );
  expect(catalogCalls).toHaveLength(1);
  expect(catalogCalls[0][0]).toContain('sourceConversationId=architect');
  expect(catalogCalls[0][0]).toContain('clientId=catalog-client');
  expect(request.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  expect(unexpected).toEqual([]);
});
