// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MitzoApiClient } from '@mitzo/client';
import { COLLABORATION_EXECUTION_DISABLED, type CollaborationView } from '@mitzo/protocol';
import { createConversationJoiningApplicationOwner as create } from '../conversation-joining-application-owner';
import { useConversationJoiningReview } from '../../hooks/useConversationJoiningReview';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../preview/conversation-joining-fixture';
import type { ConversationJoiningReviewRequest } from '../conversation-joining-review';
import { conversationJoiningRecovery, joiningReviewFence } from '../conversation-joining-recovery';
import * as auth from '../api-fetch';

const group = '00000000-0000-4000-8000-000000000010';
const requestId = '00000000-0000-4000-8000-000000000020';
const brief = '  Exact edited brief.\nPreserve these bytes.  ';
const initialBase = import.meta.env.VITE_API_BASE_URL;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'adapter-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  import.meta.env.VITE_API_BASE_URL = initialBase;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Recording HTTP responses exercise the browser contract only. They do not
// establish real server, account, workspace, source or capacity authority.
// Every review response explicitly remains UNVERIFIED.
function input(): ConversationJoiningReviewRequest {
  return {
    requestId,
    joiningBrief: brief,
    setup: {
      ...joiningSetupFixture(),
      artifacts: [],
      repositoryWorkspaceId: 'selected-unused-workspace',
      permissionMode: 'ask' as const,
    },
  };
}
function fixtures() {
  const response = joiningReviewFixture({
    joiningBrief: brief,
    artifacts: [],
    capacity: { status: 'unverified', reason: 'No native capacity adapter installed' },
  });
  response.settings.repositoryWorkspaceId = 'selected-unused-workspace';
  response.settings.selection.permission.mode = 'ask';
  response.artifactLabels = [];
  const transcript = {
    sourceConversationId: 'source-chat',
    boundary: { sequence: 9, messageId: 'message-two' },
    messages: [
      response.snapshot.messages[0],
      {
        ...structuredClone(response.snapshot.messages[0]),
        messageId: 'message-two',
        sequence: 9,
      },
    ],
  };
  response.snapshot.boundary = transcript.boundary;
  const view: CollaborationView = {
    version: 1,
    collaborationId: group,
    membershipRevision: 1,
    participantSessionIds: ['source-chat'],
    unavailableParticipantSessionIds: [],
    cursor: 0,
    policySequence: 0,
    policies: [],
    messages: [],
    hasEarlierMessages: false,
    joins: [],
    execution: COLLABORATION_EXECUTION_DISABLED,
  };
  return { response, transcript, view };
}
async function harness() {
  const data = fixtures();
  let clientId: string | undefined = 'connection-first';
  let loseReview = false;
  let refusal = false;
  let afterResponse: ((url: string) => void) | undefined;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    let response: Response;
    if (url.endsWith('?transcript=durable')) response = Response.json(data.transcript);
    else if (url.endsWith('/conversation')) response = Response.json(data.view);
    else if (url.endsWith('/reviews')) {
      if (loseReview) {
        loseReview = false;
        throw Error('Review response unavailable');
      }
      response = refusal
        ? Response.json(
            { error: 'Route unavailable', code: 'execution_unavailable' },
            { status: 503 },
          )
        : Response.json(data.response);
    } else if (/\/joins(?:\/.*\/recover)?$/.test(url))
      response = Response.json(
        { error: 'Joining unavailable', code: 'execution_unavailable' },
        { status: 503 },
      );
    else throw Error(`Unexpected request: ${url}`);
    afterResponse?.(url);
    return response;
  });
  const api = new MitzoApiClient(fetch);
  const options = {
    api,
    sourceConversationId: 'source-chat',
    collaborationId: group,
    getClientId: () => clientId,
    getVerifiedAuthScope: auth.currentVerifiedAuthSessionId,
  };
  const owner = create(options);
  return {
    data,
    api,
    fetch,
    owner,
    create,
    options,
    client: (id: string | undefined) => {
      clientId = id;
    },
    loseResponse: () => {
      loseReview = true;
    },
    refuse: () => {
      refusal = true;
    },
    afterResponse: (callback: (url: string) => void) => {
      afterResponse = callback;
    },
  };
}

it('captures exact public intent using only the typed durable source and current view reads', async () => {
  const h = await harness(),
    controller = new AbortController();
  const request = input();
  request.setup.messageIds = ['message-two', 'message-one'];
  request.setup.artifacts = [
    { artifactId: 'second', revision: 2, sha256: 'b'.repeat(64) },
    { artifactId: 'first', revision: 1, sha256: 'a'.repeat(64) },
  ];
  const captured = await h.owner.captureReview(request, controller.signal);
  expect(captured).toEqual({
    selection: {
      requestId,
      expectedMembershipRevision: 1,
      sourceConversationId: 'source-chat',
      boundary: h.data.transcript.boundary,
      mode: 'selected',
      messageIds: request.setup.messageIds,
      artifacts: request.setup.artifacts,
      purpose: request.setup.purpose,
      joiningBrief: brief,
    },
    target: {
      runOn: 'local',
      accountId: 'offline-account',
      model: 'offline-fixture',
      reasoningEffort: null,
      agent: request.setup.agent,
      repositoryWorkspaceId: 'selected-unused-workspace',
      permissionMode: 'ask',
    },
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
  expect(h.fetch.mock.calls.map(([url]) => url).sort()).toEqual(
    [
      '/api/sessions/source-chat/messages?transcript=durable',
      `/api/session-collaborations/${group}/conversation`,
    ].sort(),
  );
  for (const [, init] of h.fetch.mock.calls) {
    expect(init?.method).not.toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(JSON.stringify(captured)).not.toMatch(
    /capacity|binding|clientId|Visible|snapshotId|credential|nativeWitness/,
  );
  expect(JSON.stringify(captured)).not.toContain(h.data.transcript.messages[0].blocks[0].content);
});

it('requires an existing verified login to construct an owner without performing reads', async () => {
  const h = await harness();
  auth.markAuthLost();
  expect(() => h.create(h.options)).toThrow('Application review owner unavailable');
  expect(h.fetch).not.toHaveBeenCalled();
});

it('captures independent intent before asynchronous read callbacks can mutate the caller draft', async () => {
  const h = await harness(),
    request = input();
  const expected = structuredClone(request);
  h.afterResponse(() => {
    request.setup.selection!.model = 'Changed after capture began';
    request.setup.messageIds.push('unrelated');
    request.setup.agent!.revision++;
    request.setup.repositoryWorkspaceId = 'changed-workspace';
    request.joiningBrief = 'Changed after capture began';
  });
  const captured = await h.owner.captureReview(request, new AbortController().signal);
  expect(captured.target.model).toBe(expected.setup.selection!.model);
  expect(captured.target.agent).toEqual(expected.setup.agent);
  expect(captured.target.repositoryWorkspaceId).toBe(expected.setup.repositoryWorkspaceId);
  expect(captured.selection.messageIds).toEqual(expected.setup.messageIds);
  expect(captured.selection.joiningBrief).toBe(expected.joiningBrief);
});

it('serializes an independently parsed review clone and performs no capture reads', async () => {
  const h = await harness(),
    captured = await h.owner.captureReview(input(), new AbortController().signal);
  const expected = structuredClone(captured);
  h.fetch.mockClear();
  const pending = h.owner.review(captured, new AbortController().signal);
  captured.target.model = 'Caller mutation';
  captured.selection.joiningBrief = 'Caller mutation';
  await pending;
  expect(h.fetch).toHaveBeenCalledTimes(1);
  const { clientId, ...wire } = JSON.parse(h.fetch.mock.calls[0][1]!.body as string);
  expect(clientId).toBe('connection-first');
  expect(wire).toEqual(expected);
});

// Existing protocol/compiler semantics distinguish missing intent from an
// explicitly empty edit. The initial nonblank adapter rule was too restrictive.
it.each(['', ' \n '])(
  'preserves explicitly supplied brief bytes during capture and review: %j',
  async (joiningBrief) => {
    const h = await harness(),
      request = input();
    request.joiningBrief = joiningBrief;
    const captured = await h.owner.captureReview(request, new AbortController().signal);
    expect(captured.selection.joiningBrief).toBe(joiningBrief);
    h.data.response.snapshot.joiningBrief = joiningBrief;
    h.fetch.mockClear();
    await h.owner.review(captured, new AbortController().signal);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.fetch.mock.calls[0][1]!.body as string).selection.joiningBrief).toBe(
      joiningBrief,
    );
  },
);

it.each(['', ' \n '])(
  'replays the exact old-v2 captured brief %j without reads or replacing its receipt',
  async (joiningBrief) => {
    const h = await harness(),
      request = input();
    const captured = await h.owner.captureReview(request, new AbortController().signal);
    captured.selection.joiningBrief = joiningBrief;
    request.joiningBrief = joiningBrief;
    delete request.setup.repositoryWorkspaceId;
    delete request.setup.permissionMode;
    h.data.response.snapshot.joiningBrief = joiningBrief;
    const storage = conversationJoiningRecovery('source-chat');
    const original = storage.save(
      {
        version: 2,
        sourceConversationId: 'source-chat',
        reviewRequest: request,
        application: { state: 'captured', collaborationId: group, input: captured },
        acceptedReview: joiningReviewFence(h.data.response),
      },
      null,
    );
    h.fetch.mockClear();
    h.client('connection-renewed');
    const hook = renderHook(() => useConversationJoiningReview(h.owner));
    await act(() => hook.result.current.retryReview());
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0][0]).toBe(`/api/session-collaborations/${group}/reviews`);
    const { clientId, ...wire } = JSON.parse(h.fetch.mock.calls[0][1]!.body as string);
    expect(clientId).toBe('connection-renewed');
    expect(wire).toEqual(captured);
    expect(storage.read()).toEqual(original);
    expect(hook.result.current.brief).toBe(joiningBrief);
    expect(hook.result.current.review?.snapshot.capacity.status).toBe('unverified');
    expect(hook.result.current.canConfirm).toBe(false);
  },
);

it.each(['repository', 'permission', 'brief', 'account', 'agent'] as const)(
  'refuses missing %s before any read',
  async (missing) => {
    const h = await harness(),
      request = input();
    if (missing === 'repository')
      delete (request.setup as Partial<typeof request.setup>).repositoryWorkspaceId;
    if (missing === 'permission')
      delete (request.setup as Partial<typeof request.setup>).permissionMode;
    if (missing === 'brief') delete (request as Partial<typeof request>).joiningBrief;
    if (missing === 'account') request.setup.selection = null;
    if (missing === 'agent') request.setup.agent = null;
    await expect(h.owner.captureReview(request, new AbortController().signal)).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  },
);

it.each(['source', 'group', 'membership', 'unavailable', 'selected', 'duplicate'] as const)(
  'refuses mismatched %s source selection without POST',
  async (change) => {
    const h = await harness(),
      request = input();
    if (change === 'source') h.data.transcript.sourceConversationId = 'other';
    if (change === 'group') h.data.view.collaborationId = '00000000-0000-4000-8000-000000000011';
    if (change === 'membership') h.data.view.participantSessionIds = ['other'];
    if (change === 'unavailable') h.data.view.unavailableParticipantSessionIds = ['source-chat'];
    if (change === 'selected') request.setup.messageIds = ['provider-message-not-durable'];
    if (change === 'duplicate') request.setup.messageIds = ['message-one', 'message-one'];
    await expect(h.owner.captureReview(request, new AbortController().signal)).rejects.toThrow();
    expect(h.fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  },
);

it('preserves prior refreeze, object-key equivalence and exact edited strings', async () => {
  const h = await harness(),
    request = {
      ...input(),
      previousSnapshot: {
        snapshotId: '00000000-0000-4000-8000-000000000030',
        sha256: 'c'.repeat(64),
      },
    };
  const first = await h.owner.captureReview(request, new AbortController().signal);
  const second = await h.owner.captureReview(
    {
      ...request,
      setup: {
        ...request.setup,
        selection: {
          model: 'offline-fixture',
          reasoningEffort: null,
          accountId: 'offline-account',
        },
      },
    },
    new AbortController().signal,
  );
  expect(second).toEqual(first);
  expect(first.selection.joiningBrief).toBe(brief);
  expect(first.previousSnapshot).toEqual(request.previousSnapshot);
});

it.each(['capture', 'review', 'confirm', 'recover'] as const)(
  'refuses %s after verified login replacement',
  async (operation) => {
    const h = await harness();
    const captured = await h.owner.captureReview(input(), new AbortController().signal);
    h.fetch.mockClear();
    auth.markAuthLost();
    const result =
      operation === 'capture'
        ? h.owner.captureReview(input(), new AbortController().signal)
        : operation === 'review'
          ? h.owner.review(captured, new AbortController().signal)
          : operation === 'recover'
            ? h.owner.recover('00000000-0000-4000-8000-000000000040', new AbortController().signal)
            : h.owner.confirm({
                requestId,
                expectedMembershipRevision: 1,
                name: 'Reviewer',
                settings: h.data.response.settings,
                snapshot: {
                  snapshotId: h.data.response.snapshot.snapshotId,
                  sha256: h.data.response.snapshot.sha256,
                },
              });
    await expect(result).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  },
);

it.each(['capture', 'review'] as const)(
  'refuses %s after application base replacement',
  async (operation) => {
    const h = await harness(),
      captured = await h.owner.captureReview(input(), new AbortController().signal);
    h.fetch.mockClear();
    import.meta.env.VITE_API_BASE_URL = 'https://other.invalid';
    await expect(
      operation === 'capture'
        ? h.owner.captureReview(input(), new AbortController().signal)
        : h.owner.review(captured, new AbortController().signal),
    ).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  },
);

it.each(['capture', 'review', 'recover'] as const)(
  'refuses already-cancelled %s without HTTP effects',
  async (operation) => {
    const h = await harness(),
      captured = await h.owner.captureReview(input(), new AbortController().signal);
    h.fetch.mockClear();
    const controller = new AbortController();
    controller.abort();
    await expect(
      operation === 'capture'
        ? h.owner.captureReview(input(), controller.signal)
        : operation === 'review'
          ? h.owner.review(captured, controller.signal)
          : h.owner.recover('00000000-0000-4000-8000-000000000040', controller.signal),
    ).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ['capture', 'auth'],
  ['capture', 'base'],
  ['capture', 'abort'],
  ['review', 'auth'],
  ['review', 'base'],
  ['review', 'abort'],
] as const)(
  'rejects stale %s completion after %s despite a transport ignoring the signal',
  async (operation, change) => {
    const h = await harness(),
      controller = new AbortController();
    const captured = await h.owner.captureReview(input(), controller.signal);
    h.afterResponse(() => {
      if (change === 'auth') auth.markAuthLost();
      else if (change === 'base') import.meta.env.VITE_API_BASE_URL = 'https://other.invalid';
      else controller.abort();
    });
    await expect(
      operation === 'capture'
        ? h.owner.captureReview(input(), controller.signal)
        : h.owner.review(captured, controller.signal),
    ).rejects.toThrow();
  },
);

it('replays retained normalized wire through actual hook/journal/client with current connection, no capture reads or readiness promotion', async () => {
  const h = await harness(),
    request = input(),
    storage = conversationJoiningRecovery('source-chat');
  storage.save(
    {
      version: 2,
      sourceConversationId: 'source-chat',
      reviewRequest: request,
      application: { state: 'capture_pending', collaborationId: group },
    },
    null,
  );
  h.loseResponse();
  const first = renderHook(() => useConversationJoiningReview(h.owner));
  await act(() => first.result.current.retryReview());
  expect(first.result.current.error).toBeTruthy();
  const original = storage.read();
  expect(original?.version === 2 ? original.application.state : null).toBe('captured');
  const firstPost = h.fetch.mock.calls.find(([url]) => url.endsWith('/reviews'))!;
  first.unmount();
  h.fetch.mockClear();
  h.client('connection-renewed');
  h.data.transcript.boundary = { sequence: 20, messageId: 'later' };
  h.data.view.membershipRevision = 2;
  const next = renderHook(() => useConversationJoiningReview(h.owner));
  await act(() => next.result.current.retryReview());
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.fetch.mock.calls[0][0]).toBe(`/api/session-collaborations/${group}/reviews`);
  const { clientId: oldClient, ...oldWire } = JSON.parse(firstPost[1]!.body as string);
  const { clientId: nextClient, ...nextWire } = JSON.parse(
    h.fetch.mock.calls[0][1]!.body as string,
  );
  expect(oldClient).toBe('connection-first');
  expect(nextClient).toBe('connection-renewed');
  expect(nextWire).toEqual(oldWire);
  expect(next.result.current.review?.snapshot.capacity.status).toBe('unverified');
  expect(next.result.current.canConfirm).toBe(false);
  expect(JSON.stringify(storage.read())).not.toMatch(
    /clientId|capacity|assessments|nativeWitness|credential/,
  );
});

it('refuses foreign source and absent current connection before review POST', async () => {
  const h = await harness(),
    captured = await h.owner.captureReview(input(), new AbortController().signal);
  h.fetch.mockClear();
  const foreign = structuredClone(captured);
  foreign.selection.sourceConversationId = 'other';
  await expect(h.owner.review(foreign, new AbortController().signal)).rejects.toThrow();
  h.client(undefined);
  await expect(h.owner.review(captured, new AbortController().signal)).rejects.toThrow();
  expect(h.fetch).not.toHaveBeenCalled();
});

it('retains exact published custom-profile selection and surfaces actual typed server refusal without tool filtering', async () => {
  const h = await harness(),
    request = input();
  request.setup.agent = { profileId: 'published-custom-tools', revision: 7 };
  const captured = await h.owner.captureReview(request, new AbortController().signal);
  h.refuse();
  await expect(h.owner.review(captured, new AbortController().signal)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  const wire = JSON.parse(h.fetch.mock.calls.at(-1)![1]!.body as string);
  expect(wire.target.agent).toEqual(request.setup.agent);
  expect(captured.target.agent).toEqual(request.setup.agent);
});

it('delegates explicit confirmation and recovery to existing typed routes without replacing their unavailable outcome', async () => {
  const h = await harness();
  const confirmation = {
    requestId,
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings: h.data.response.settings,
    snapshot: {
      snapshotId: h.data.response.snapshot.snapshotId,
      sha256: h.data.response.snapshot.sha256,
    },
  };
  await expect(h.owner.confirm(confirmation)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  const id = '00000000-0000-4000-8000-000000000040';
  await expect(h.owner.recover(id, new AbortController().signal)).rejects.toMatchObject({
    status: 503,
    code: 'execution_unavailable',
  });
  expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/session-collaborations/${group}/joins`,
    `/api/session-collaborations/${group}/joins/${id}/recover`,
  ]);
  expect(JSON.parse(h.fetch.mock.calls[0][1]!.body as string)).toEqual(confirmation);
});
