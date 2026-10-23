// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePendingLaunch } from '../usePendingLaunch';
import { OrdinaryRuntimeFirstCommandSchema } from '@mitzo/protocol';
import {
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  chatDraftStorageKey,
} from '../../lib/chat-drafts';
import { launchDraftDelivery } from '../../lib/launch-draft-delivery';
import { agentBuilderCommandHandoff } from '../../lib/agent-builder-chat';
import {
  briefingCommandHandoff,
  localBriefingConversation,
  confirmBriefingRegistration,
} from '../../lib/briefing-registration';
import { createReviewedOutboxStorage } from '../../lib/reviewed-outbox-storage';
import { apiFetch } from '../../lib/api-fetch';
const channel = vi.hoisted(() => ({
  id: 'live-sse',
  listener: (_event: Record<string, unknown>) => {},
  send: vi.fn(),
}));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'auth-lost',
}));
vi.mock('../../../../packages/client/src/sse-connection.js', () => ({
  SseConnection: class {
    onMessage(fn: typeof channel.listener) {
      channel.listener = fn;
    }
    connect() {}
    getConnectionId() {
      return channel.id;
    }
    isConnected() {
      return !!channel.id;
    }
    send = channel.send;
    getLastSeq() {
      return 0;
    }
    trackSeq() {}
    commitTranscriptCursor() {}
    getTrackedSessions() {
      return [];
    }
    clearSession() {}
    clearPendingSends() {}
    advanceSendScope() {}
    blockAuthentication() {}
    invalidateAuthentication() {}
    restoreAuthentication() {}
    checkAndReconnect() {}
    sendSuspend() {}
  },
}));
const source = {
  kind: 'briefing' as const,
  date: '2026-10-09',
  revision: 'a'.repeat(64),
  content: 'Original captured report',
};
const account = {
  accountId: 'work',
  provider: 'openai-codex' as const,
  profileRevision: 'account-r1',
};
const selection = { accountId: 'work', model: 'fixture-luna', reasoningEffort: 'low' };
const command = OrdinaryRuntimeFirstCommandSchema.parse({
  runOn: 'local',
  clientMsgId: 'briefing-owned-original',
  capabilityRevision: 'caps-r1',
  runtime: { account, harness: 'codex', targetId: 'mac', mode: 'agent' },
  selection: {
    version: 1,
    agent: { kind: 'builtin', profileId: 'default', revision: 1 },
    model: selection.model,
    thinking: 'low',
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
  },
  payload: { text: 'Discuss the original report', sourceSnapshots: [source] },
});
function draftFixture() {
  const draft = createChatDraft();
  draft.text = command.payload.text;
  draft.settings.selection = selection;
  draft.settings.runtimeSelection = {
    version: 1,
    account: selection,
    accountReference: account,
    agentProfile: command.selection.agent,
    execution: { location: 'local', targetId: 'mac' },
    capabilityRevision: 'caps-r1',
  };
  draft.settings.launch = {
    prompt: draft.text,
    context: 'Morning briefing',
    sourceSnapshots: [source],
    accountSelection: selection,
    briefing: { date: source.date, revision: source.revision },
  };
  expect(saveChatDraft(draft)).toBe(true);
  return draft;
}
function cold(handoff = briefingCommandHandoff) {
  return createMitzoStore({
    transport: { fetch: apiFetch },
    sendHandoff: handoff,
    launchDrafts: launchDraftDelivery,
    wsConfig: {
      buildUrl: () => '',
      createWebSocket: () => {
        throw Error('No WebSocket');
      },
    },
    sseConfig: { baseUrl: '', fetch: apiFetch },
    localFirstCommandConfig: {
      url: '/api/chat/local-codex/send',
      storage: createReviewedOutboxStorage(
        localStorage,
        new URL('/api/chat/local-codex/send', window.location.href).href,
        'local',
      ),
    },
  });
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  channel.id = 'live-sse';
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

it('recovers an owned briefing through actual outbox/store replacement with exact snapshots, command identity and one registration', async () => {
  const draft = draftFixture();
  let lose = true;
  let logicalTurns = 0;
  const accepted = new Set<string>();
  const sent: unknown[] = [];
  const registrations: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send') {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      if (!accepted.has(body.clientMsgId)) {
        accepted.add(body.clientMsgId);
        logicalTurns++;
      }
      if (lose) throw Error('Acknowledgement lost');
      return Response.json(
        {
          ok: true,
          clientMsgId: body.clientMsgId,
          sessionId: 'owned-briefing',
          dispatched: true,
          state: 'consumed',
        },
        { status: 202 },
      );
    }
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      registrations.push(body);
      return Response.json({ ...body, createdAt: '2026-10-23T10:00:00Z' });
    }
    return Response.json([]);
  });
  const first = cold();
  first.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
  await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
  expect(launchDraftDelivery.pending(draft.id)).toBe(true);
  expect(getChatDraft(draft.id)).not.toBeNull();
  await expect(localBriefingConversation(source, selection)).rejects.toThrow(/awaiting assignment/);
  sessionStorage.clear();
  lose = false;
  const restored = cold();
  restored.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  restored.getState().selectLocalCommandDraft(draft.id);
  expect(restored.getState().pendingSessionSending).toBe(true);
  expect(restored.getState().sendPendingSession()).toBe(false);
  expect(restored.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(restored.getState().localCommand?.state).toBe('consumed'));
  await vi.waitFor(() => expect(registrations).toHaveLength(1));
  expect(sent).toEqual([command, command]);
  expect(logicalTurns).toBe(1);
  expect(registrations[0]).toEqual({
    date: source.date,
    revision: source.revision,
    sessionId: 'owned-briefing',
    accountId: selection.accountId,
    model: selection.model,
  });
  expect(getChatDraft(draft.id)).toBeNull();
  channel.listener({
    v: 2,
    type: 'session_id',
    sessionId: 'owned-briefing',
    clientMsgId: command.clientMsgId,
  });
  expect(restored.getState().recoverLocalCommand()).toBe(false);
  expect(registrations).toHaveLength(1);
});

it.each(['snapshot', 'account', 'model', 'target', 'capability', 'profile', 'malformed'] as const)(
  'rejects %s drift before associating an owned command with the reviewed launch',
  (kind) => {
    const draft = draftFixture();
    const changed = structuredClone(command);
    if (kind === 'snapshot') changed.payload.sourceSnapshots![0].revision = 'b'.repeat(64);
    if (kind === 'account') changed.runtime.account.accountId = 'other';
    if (kind === 'model') changed.selection.model = 'other';
    if (kind === 'target') changed.runtime.targetId = 'other';
    if (kind === 'capability') changed.capabilityRevision = 'other';
    if (kind === 'profile') changed.runtime.account.profileRevision = 'other';
    if (kind === 'malformed') delete (changed.runtime as { targetId?: string }).targetId;
    expect(launchDraftDelivery.prepare(draft.id, changed)).toBe(false);
    expect(launchDraftDelivery.pending(draft.id)).toBe(false);
    expect(getChatDraft(draft.id)).not.toBeNull();
  },
);
it('keeps an existing generic uncertain receipt locked without translating it to an owned command', () => {
  const draft = draftFixture();
  expect(
    launchDraftDelivery.prepare(draft.id, {
      sessionId: null,
      clientMsgId: 'generic-old',
      prompt: command.payload.text,
      accountId: selection.accountId,
      model: selection.model,
      sourceSnapshots: [source],
    }),
  ).toBe(true);
  launchDraftDelivery.settle('generic-old', 'uncertain');
  expect(launchDraftDelivery.prepare(draft.id, command)).toBe(false);
  const store = cold();
  store.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  expect(store.getState().sendPendingSession()).toBe(false);
  expect(store.getState().recoverLocalCommand()).toBe(false);
  expect(apiFetch).not.toHaveBeenCalled();
  expect(getChatDraft(draft.id)).not.toBeNull();
});

it.each(['reserved', 'retained'] as const)(
  'does not assign or retire a briefing from a %s observation',
  async (state) => {
    const draft = draftFixture();
    vi.mocked(apiFetch).mockImplementation(async (_url) =>
      Response.json(
        state === 'retained'
          ? {
              ok: false,
              code: 'retained_command',
              error: 'Local Codex entry unavailable',
              clientMsgId: command.clientMsgId,
              sessionId: 'observed',
              state: 'consumed',
            }
          : {
              ok: true,
              clientMsgId: command.clientMsgId,
              sessionId: 'observed',
              dispatched: false,
              state,
            },
        { status: state === 'retained' ? 409 : 202 },
      ),
    );
    const store = cold();
    store.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
    expect(store.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
    await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe(state));
    expect(store.getState().sessions.active).toBeNull();
    expect(getChatDraft(draft.id)).not.toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(launchDraftDelivery.pending(draft.id)).toBe(true);
  },
);
it.each(['contextBlocks', 'telosTaskId', 'agentName', 'extraTools'] as const)(
  'retains explicitly empty historical %s before schema stripping with zero dispatch',
  (field) => {
    const draft = draftFixture();
    const raw = JSON.parse(localStorage.getItem(chatDraftStorageKey(draft.id))!);
    raw.settings.launch[field] = field === 'contextBlocks' ? [] : '';
    const retained = JSON.stringify(raw);
    localStorage.setItem(chatDraftStorageKey(draft.id), retained);
    const store = cold();
    store.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
    expect(store.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem(chatDraftStorageKey(draft.id))).toBe(retained);
    expect(launchDraftDelivery.pending(draft.id)).toBe(false);
  },
);
it('refuses mixed sources before receipt or dispatch rather than changing AgentLibrary ownership by array order', () => {
  const draft = draftFixture();
  const mixed = structuredClone(command);
  mixed.payload.sourceSnapshots!.push(source);
  const store = cold();
  expect(store.getState().sendLocalFirstCommand(mixed, { draftId: draft.id })).toBe(false);
  expect(apiFetch).not.toHaveBeenCalled();
  expect(launchDraftDelivery.pending(draft.id)).toBe(false);
});

it('retries a durable consumed receipt after assignment failure without a second provider dispatch', async () => {
  const draft = draftFixture();
  let sends = 0;
  let registrations = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send') {
      sends++;
      return Response.json(
        {
          ok: true,
          clientMsgId: command.clientMsgId,
          sessionId: 'consumed-retry',
          state: 'consumed',
          dispatched: true,
        },
        { status: 202 },
      );
    }
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
      registrations++;
      return Response.json({ ...JSON.parse(String(init.body)), createdAt: '2026-10-23T10:00:00Z' });
    }
    return Response.json([]);
  });
  const first = cold({
    ...briefingCommandHandoff,
    assign() {
      throw Error('Offline source assignment storage failure');
    },
  });
  first.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
  await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
  expect(sends).toBe(1);
  expect(registrations).toBe(0);
  const restored = cold();
  restored.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  restored.getState().selectLocalCommandDraft(draft.id);
  expect(restored.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(registrations).toBe(1));
  expect(sends).toBe(1);
  expect(getChatDraft(draft.id)).toBeNull();
});

it.each(['origin-draft', 'submitted-source', 'submitted-runtime'] as const)(
  'retains a consumed frozen entry when %s no longer matches its original receipt',
  async (drift) => {
    const draft = draftFixture();
    let sends = 0;
    let registrations = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/local-codex/send') {
        sends++;
        return Response.json(
          {
            ok: true,
            clientMsgId: command.clientMsgId,
            sessionId: 'retained-proof',
            state: 'consumed',
            dispatched: true,
          },
          { status: 202 },
        );
      }
      if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') registrations++;
      return Response.json([]);
    });
    const first = cold({
      ...briefingCommandHandoff,
      assign() {
        throw Error('Handoff temporarily unavailable');
      },
    });
    expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
    await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
    let selectedDraft = draft.id;
    if (drift === 'origin-draft') {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith('mitzo-local-first-command-outbox:'),
      )!;
      const entry = JSON.parse(localStorage.getItem(key)!);
      entry.localDraftId = 'unrelated-draft';
      selectedDraft = 'unrelated-draft';
      localStorage.setItem(key, JSON.stringify(entry));
    } else {
      const key = Object.keys(localStorage).find((key) =>
        key.startsWith('mitzo-launch-delivery:'),
      )!;
      const receipt = JSON.parse(localStorage.getItem(key)!);
      if (drift === 'submitted-source')
        receipt.submitted.settings.launch.sourceSnapshots[0].revision = 'b'.repeat(64);
      else receipt.submitted.settings.runtimeSelection.accountReference.profileRevision = 'changed';
      localStorage.setItem(key, JSON.stringify(receipt));
    }
    const restored = cold();
    restored.getState().selectLocalCommandDraft(selectedDraft);
    expect(restored.getState().recoverLocalCommand()).toBe(true);
    expect(restored.getState().localCommand?.state).toBe('uncertain');
    expect(sends).toBe(1);
    expect(registrations).toBe(0);
    expect(getChatDraft(draft.id)).not.toBeNull();
    expect(launchDraftDelivery.pending(draft.id)).toBe(true);
  },
);
it('registers reviewed thinking from the frozen command after a cold reload, independently of later draft edits', async () => {
  const draft = draftFixture();
  const reviewed = structuredClone(command);
  reviewed.selection.thinking = 'high';
  draft.settings.selection = { ...selection, reasoningEffort: 'high' };
  draft.settings.runtimeSelection!.account = { ...selection, reasoningEffort: 'high' };
  saveChatDraft(draft);
  let sends = 0;
  const registrations: unknown[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send') {
      sends++;
      return Response.json(
        {
          ok: true,
          clientMsgId: command.clientMsgId,
          sessionId: 'thinking-original',
          state: 'consumed',
          dispatched: true,
        },
        { status: 202 },
      );
    }
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
      const binding = JSON.parse(String(init.body));
      registrations.push(binding);
      return Response.json({ ...binding, createdAt: '2026-10-23T10:00:00Z' });
    }
    return Response.json([]);
  });
  const first = cold({
    ...briefingCommandHandoff,
    assign() {
      throw Error('Handoff temporarily unavailable');
    },
  });
  expect(first.getState().sendLocalFirstCommand(reviewed, { draftId: draft.id })).toBe(true);
  await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
  const changed = getChatDraft(draft.id)!;
  changed.settings.selection = { accountId: 'different', model: 'different' };
  saveChatDraft(changed);
  const restored = cold();
  restored.getState().selectLocalCommandDraft(draft.id);
  expect(restored.getState().recoverLocalCommand()).toBe(true);
  await vi.waitFor(() => expect(registrations).toHaveLength(1));
  expect(sends).toBe(1);
  const stored = Object.keys(localStorage).find(
    (key) => key.includes('mitzo-briefing-registrations:') && key.endsWith(':thinking-original'),
  )!;
  expect(JSON.parse(localStorage.getItem(stored)!)).toMatchObject({
    reasoningEffort: 'high',
    binding: { accountId: 'work', model: 'fixture-luna' },
  });
  expect(getChatDraft(draft.id)?.settings.selection).toEqual(changed.settings.selection);
});

it('keeps original submitted proof through accepted launch cleanup when final outbox removal fails', async () => {
  const draft = draftFixture();
  let sends = 0;
  let registrations = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send') {
      sends++;
      return Response.json(
        {
          ok: true,
          clientMsgId: command.clientMsgId,
          sessionId: 'cleanup-retry',
          state: 'consumed',
          dispatched: true,
        },
        { status: 202 },
      );
    }
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
      registrations++;
      return Response.json({ ...JSON.parse(String(init.body)), createdAt: '2026-10-23T10:00:00Z' });
    }
    return Response.json([]);
  });
  const remove = Storage.prototype.removeItem;
  const failure = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
    this: Storage,
    key,
  ) {
    if (key.startsWith('mitzo-local-first-command-outbox:'))
      throw Error('Final outbox removal unavailable');
    return remove.call(this, key);
  });
  const first = cold();
  expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
  await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
  await vi.waitFor(() => expect(registrations).toBe(1));
  failure.mockRestore();
  const restored = cold();
  restored.getState().selectLocalCommandDraft(draft.id);
  expect(restored.getState().recoverLocalCommand()).toBe(true);
  expect(restored.getState().localCommand?.state).toBe('consumed');
  expect(sends).toBe(1);
  expect(registrations).toBe(1);
  const receiptKey = Object.keys(localStorage).find((key) =>
    key.startsWith('mitzo-launch-delivery:'),
  )!;
  expect(JSON.parse(localStorage.getItem(receiptKey)!)).not.toHaveProperty('submitted');
  expect(JSON.parse(localStorage.getItem(receiptKey)!)).toMatchObject({
    state: 'accepted',
    sessionId: 'cleanup-retry',
    clientMsgId: command.clientMsgId,
  });
  expect(
    Object.keys(localStorage).some((key) => key.startsWith('mitzo-local-first-command-outbox:')),
  ).toBe(false);
});

it('does not let a different saved draft reuse a pending owned command identity or replace its receipt', async () => {
  const original = draftFixture();
  vi.mocked(apiFetch).mockRejectedValue(Error('Offline acknowledgement loss'));
  const store = cold();
  expect(store.getState().sendLocalFirstCommand(command, { draftId: original.id })).toBe(true);
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('uncertain'));
  const retained = new Map(
    Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
  );
  const replacement = draftFixture();
  expect(launchDraftDelivery.prepare(replacement.id, command)).toBe(false);
  for (const [key, raw] of retained) expect(localStorage.getItem(key)).toBe(raw);
  expect(getChatDraft(original.id)).not.toBeNull();
  expect(getChatDraft(replacement.id)).not.toBeNull();
});

it('never resurrects a durably retired command when sensitive receipt cleanup throws', async () => {
  const draft = draftFixture();
  let sends = 0;
  let registrations = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send') {
      sends++;
      return Response.json(
        {
          ok: true,
          clientMsgId: command.clientMsgId,
          sessionId: 'cleanup-failed',
          state: 'consumed',
          dispatched: true,
        },
        { status: 202 },
      );
    }
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
      registrations++;
      return Response.json({ ...JSON.parse(String(init.body)), createdAt: '2026-10-23T10:00:00Z' });
    }
    return Response.json([]);
  });
  const set = Storage.prototype.setItem;
  const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (
      key.startsWith('mitzo-launch-delivery:') &&
      JSON.parse(value).state === 'accepted' &&
      !JSON.parse(value).submitted
    )
      throw Error('Sensitive cleanup unavailable');
    return set.call(this, key, value);
  });
  const store = cold();
  expect(store.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
  await vi.waitFor(() => expect(registrations).toBe(1));
  expect(store.getState().localCommand?.state).toBe('consumed');
  expect(
    Object.keys(localStorage).some((key) => key.startsWith('mitzo-local-first-command-outbox:')),
  ).toBe(false);
  failure.mockRestore();
  const restored = cold();
  restored.getState().selectLocalCommandDraft(draft.id);
  expect(restored.getState().recoverLocalCommand()).toBe(false);
  launchDraftDelivery.finalize(command.clientMsgId);
  launchDraftDelivery.finalize(command.clientMsgId);
  expect(sends).toBe(1);
  expect(registrations).toBe(1);
});

it.each(['launch-receipt', 'source-receipt', 'outbox-enqueue'] as const)(
  'releases only this attempt when %s cannot persist, without dispatch or orphan source intent',
  async (failurePoint) => {
    const draft = draftFixture();
    const retained = localStorage.getItem(chatDraftStorageKey(draft.id));
    const set = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        (failurePoint === 'launch-receipt' && key.startsWith('mitzo-launch-delivery:')) ||
        (failurePoint === 'source-receipt' && key.includes('-commands:')) ||
        (failurePoint === 'outbox-enqueue' && key.startsWith('mitzo-local-first-command-outbox:'))
      )
        throw Error('Injected durable storage failure');
      return set.call(this, key, value);
    });
    const store = cold();
    expect(store.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(false);
    failure.mockRestore();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(launchDraftDelivery.pending(draft.id)).toBe(false);
    expect(localStorage.getItem(chatDraftStorageKey(draft.id))).toBe(retained);
    await expect(localBriefingConversation(source, selection)).resolves.toBeNull();
  },
);

it.each([
  'fresh',
  'other-chat',
  'new-context',
  'explicit-clear',
  'different-draft',
  'assignment-failure',
] as const)(
  'restores original cold display context only for its uninitialized foreground owner: %s',
  async (scenario) => {
    const draft = draftFixture();
    let sends = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/local-codex/send') {
        sends++;
        return Response.json(
          {
            ok: true,
            clientMsgId: command.clientMsgId,
            sessionId: 'context-owner',
            state: 'consumed',
            dispatched: true,
          },
          { status: 202 },
        );
      }
      if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST')
        return Response.json({
          ...JSON.parse(String(init.body)),
          createdAt: '2026-10-23T10:00:00Z',
        });
      return Response.json([]);
    });
    const failedHandoff = {
      ...briefingCommandHandoff,
      assign() {
        throw Error('Handoff temporarily unavailable');
      },
    };
    const first = cold(failedHandoff);
    expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
    await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
    const restored = cold(
      scenario === 'assignment-failure' ? failedHandoff : briefingCommandHandoff,
    );
    restored.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
    restored.getState().selectLocalCommandDraft(draft.id);
    if (scenario === 'other-chat') {
      await restored.getState().switchSession('other-conversation');
      restored.getState().selectLocalCommandDraft(draft.id);
    }
    if (scenario === 'new-context')
      restored
        .getState()
        .dispatchMessages({ type: 'SET_SESSION_CONTEXT', context: 'Newer explicit context' });
    if (scenario === 'explicit-clear')
      restored.getState().dispatchMessages({
        type: 'SET_SESSION_CONTEXT',
        // Defensive runtime caller: do not widen the typed display-context contract.
        context: null as unknown as string,
      });
    if (scenario === 'different-draft')
      restored.getState().setPendingSession({
        ...draft.settings.launch!,
        draftId: 'newer-draft',
        context: 'Newer draft context',
      });
    expect(restored.getState().recoverLocalCommand()).toBe(true);
    expect(restored.getState().messages.sessionContext).toBe(
      scenario === 'fresh'
        ? 'Morning briefing'
        : scenario === 'new-context'
          ? 'Newer explicit context'
          : null,
    );
    if (scenario === 'other-chat')
      expect(restored.getState().sessions.active).toBe('other-conversation');
    if (scenario === 'assignment-failure')
      expect(restored.getState().localCommand?.state).toBe('uncertain');
    expect(sends).toBe(1);
  },
);

it('does not adopt a live observer origin when the saved original draft is selected after dispatch', async () => {
  const draft = draftFixture();
  let finish!: (response: Response) => void;
  const assigned = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url) === '/api/chat/local-codex/send')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST')
      return Response.json({ ...JSON.parse(String(init.body)), createdAt: '2026-10-23T10:00:00Z' });
    return Response.json([]);
  });
  const store = cold();
  expect(
    store
      .getState()
      .sendLocalFirstCommand(command, { draftId: draft.id, onSessionAssigned: assigned }),
  ).toBe(true);
  store.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  store.getState().selectLocalCommandDraft(draft.id);
  finish(
    Response.json(
      {
        ok: true,
        clientMsgId: command.clientMsgId,
        sessionId: 'live-origin',
        state: 'consumed',
        dispatched: true,
      },
      { status: 202 },
    ),
  );
  await vi.waitFor(() => expect(store.getState().localCommand?.state).toBe('consumed'));
  expect(assigned).toHaveBeenCalledWith('live-origin');
  expect(store.getState().sessions.active).toBeNull();
  expect(store.getState().messages.sessionContext).toBeNull();
});

it('keeps the existing actionable capacity error for an owned briefing without dispatching either transport', () => {
  const draft = draftFixture();
  const original = localStorage.getItem(chatDraftStorageKey(draft.id));
  for (let i = 0; i < 256; i++) {
    const sessionId = `capacity-${i}`;
    localStorage.setItem(
      `mitzo-briefing-registrations:${window.location.origin}:${sessionId}`,
      JSON.stringify({
        binding: {
          date: source.date,
          revision: source.revision,
          sessionId,
          accountId: selection.accountId,
          model: selection.model,
        },
        token: sessionId,
        status: 'pending',
        reasoningEffort: 'low',
      }),
    );
  }
  const store = cold();
  store.getState().setPendingSession({ ...draft.settings.launch!, draftId: draft.id });
  const owned = vi.spyOn(store.getState(), 'sendLocalFirstCommand');
  const generic = vi.spyOn(store.getState(), 'sendPendingSession');
  const hook = renderHook(() => usePendingLaunch(draft.id), {
    wrapper: ({ children }) => <MitzoStoreProvider value={store}>{children}</MitzoStoreProvider>,
  });
  let sent: boolean | undefined;
  act(() => {
    sent = hook.result.current.sendBriefingCommand(command);
  });
  expect(sent).toBe(false);
  expect(owned).not.toHaveBeenCalled();
  expect(generic).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
  expect(localStorage.getItem(chatDraftStorageKey(draft.id))).toBe(original);
  expect(hook.result.current.registrationError).toBe(
    'Save the existing briefing links before starting another minion conversation.',
  );
});

it.each(['exact', 'session', 'client', 'source', 'account', 'runtime'] as const)(
  'recovers accepted source assignment after normal registration confirmation only for exact proof: %s',
  async (drift) => {
    const draft = draftFixture();
    const binding = {
      date: source.date,
      revision: source.revision,
      sessionId: 'confirmed-owner',
      accountId: selection.accountId,
      model: selection.model,
    };
    let dispatches = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/local-codex/send') {
        dispatches++;
        return Response.json(
          {
            ok: true,
            clientMsgId: command.clientMsgId,
            sessionId: binding.sessionId,
            state: 'consumed',
            dispatched: true,
          },
          { status: 202 },
        );
      }
      if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST')
        return Response.json({ ...binding, createdAt: '2026-10-23T10:00:00Z' });
      return Response.json([]);
    });
    const remove = Storage.prototype.removeItem;
    const failure = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (key.startsWith('mitzo-local-first-command-outbox:'))
        throw Error('Outbox retirement write failed');
      return remove.call(this, key);
    });
    const first = cold();
    expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
    await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
    const registrationKey = Object.keys(localStorage).find(
      (key) => key.includes('mitzo-briefing-registrations:') && key.endsWith(':confirmed-owner'),
    )!;
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(registrationKey)!)).toMatchObject({
        status: 'confirmed',
      }),
    );
    failure.mockRestore();
    // Retained baseline accepted receipts may predate completed source metadata.
    for (const key of Object.keys(localStorage))
      if (key.includes('-commands:')) localStorage.removeItem(key);
    confirmBriefingRegistration({ ...binding, createdAt: '2026-10-23T10:00:00Z' });
    expect(localStorage.getItem(registrationKey)).toBeNull();
    const receiptKey = Object.keys(localStorage).find((key) =>
      key.startsWith('mitzo-launch-delivery:'),
    )!;
    const receipt = JSON.parse(localStorage.getItem(receiptKey)!);
    expect(receipt.state).toBe('accepted');
    if (drift === 'session') receipt.sessionId = 'other-session';
    if (drift === 'client') receipt.clientMsgId = 'other-command';
    if (drift === 'source')
      receipt.submitted.settings.launch.sourceSnapshots[0].revision = 'b'.repeat(64);
    if (drift === 'account')
      receipt.submitted.settings.runtimeSelection.accountReference.accountId = 'other-account';
    if (drift === 'runtime')
      receipt.submitted.settings.runtimeSelection.execution.targetId = 'other-target';
    localStorage.setItem(receiptKey, JSON.stringify(receipt));
    const calls = vi.mocked(apiFetch).mock.calls.length;
    const restored = cold();
    restored.getState().newSession();
    restored.getState().selectLocalCommandDraft(draft.id);
    expect(restored.getState().recoverLocalCommand()).toBe(true);
    expect(restored.getState().localCommand?.state).toBe(
      drift === 'exact' ? 'consumed' : 'uncertain',
    );
    expect(dispatches).toBe(1);
    expect(apiFetch).toHaveBeenCalledTimes(calls);
    expect(
      Object.keys(localStorage).some((key) => key.startsWith('mitzo-local-first-command-outbox:')),
    ).toBe(drift !== 'exact');
    if (drift === 'exact')
      expect(JSON.parse(localStorage.getItem(receiptKey)!)).not.toHaveProperty('submitted');
  },
);

it.each(['exact', 'other-session', 'cleanup-failure'] as const)(
  'retains completed source proof through failed pending launch assignment and normal confirmation: %s',
  async (drift) => {
    const draft = draftFixture();
    const binding = {
      date: source.date,
      revision: source.revision,
      sessionId: 'pending-confirmed-owner',
      accountId: selection.accountId,
      model: selection.model,
    };
    let dispatches = 0,
      registrations = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/local-codex/send') {
        dispatches++;
        return Response.json(
          {
            ok: true,
            clientMsgId: command.clientMsgId,
            sessionId: binding.sessionId,
            state: 'consumed',
            dispatched: true,
          },
          { status: 202 },
        );
      }
      if (String(url) === '/api/home/briefing-chats' && init?.method === 'POST') {
        registrations++;
        return Response.json({ ...binding, createdAt: '2026-10-23T10:00:00Z' });
      }
      return Response.json([]);
    });
    const set = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key.startsWith('mitzo-launch-delivery:') && JSON.parse(value).sessionId)
        throw Error('Launch assignment write failed');
      return set.call(this, key, value);
    });
    const first = cold(agentBuilderCommandHandoff);
    expect(first.getState().sendLocalFirstCommand(command, { draftId: draft.id })).toBe(true);
    await vi.waitFor(() => expect(first.getState().localCommand?.state).toBe('uncertain'));
    const receiptKey = Object.keys(localStorage).find((key) =>
      key.startsWith('mitzo-launch-delivery:'),
    )!;
    expect(JSON.parse(localStorage.getItem(receiptKey)!)).toMatchObject({ state: 'pending' });
    const registrationKey = Object.keys(localStorage).find(
      (key) =>
        key.includes('mitzo-briefing-registrations:') && key.endsWith(':pending-confirmed-owner'),
    )!;
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(registrationKey)!)).toMatchObject({
        status: 'confirmed',
      }),
    );
    confirmBriefingRegistration({ ...binding, createdAt: '2026-10-23T10:00:00Z' });
    expect(localStorage.getItem(registrationKey)).toBeNull();
    failure.mockRestore();
    const intentKey = Object.keys(localStorage).find((key) => key.includes('-commands:'));
    if (drift === 'other-session' && intentKey) {
      const intent = JSON.parse(localStorage.getItem(intentKey)!);
      intent.sessionId = 'other-session';
      localStorage.setItem(intentKey, JSON.stringify(intent));
    }
    const unrelatedKey = `mitzo-briefing-registrations:${window.location.origin}-commands:other-pending`;
    const unrelated = JSON.stringify({
      date: source.date,
      revision: source.revision,
      accountId: 'other',
      model: 'other',
      clientMsgId: 'other-pending',
    });
    localStorage.setItem(unrelatedKey, unrelated);
    const remove = Storage.prototype.removeItem;
    const cleanupFailure =
      drift === 'cleanup-failure'
        ? vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
            this: Storage,
            key,
          ) {
            if (key === intentKey) throw Error('Source cleanup unavailable');
            return remove.call(this, key);
          })
        : undefined;
    const calls = vi.mocked(apiFetch).mock.calls.length;
    const restored = cold(agentBuilderCommandHandoff);
    restored.getState().newSession();
    restored.getState().selectLocalCommandDraft(draft.id);
    expect(restored.getState().recoverLocalCommand()).toBe(true);
    expect(restored.getState().localCommand?.state).toBe(
      drift === 'other-session' ? 'uncertain' : 'consumed',
    );
    expect(dispatches).toBe(1);
    expect(registrations).toBe(1);
    expect(apiFetch).toHaveBeenCalledTimes(calls);
    expect(localStorage.getItem(unrelatedKey)).toBe(unrelated);
    if (drift !== 'other-session') {
      expect(intentKey).toBeDefined();
      expect(localStorage.getItem(intentKey!)).toEqual(
        drift === 'cleanup-failure' ? expect.any(String) : null,
      );
      expect(
        Object.keys(localStorage).some((key) =>
          key.startsWith('mitzo-local-first-command-outbox:'),
        ),
      ).toBe(false);
      if (drift === 'cleanup-failure') {
        expect(JSON.parse(localStorage.getItem(receiptKey)!)).toHaveProperty('submitted');
        cleanupFailure!.mockRestore();
        agentBuilderCommandHandoff.finalize(command.clientMsgId);
        launchDraftDelivery.finalize(command.clientMsgId);
      }
      expect(JSON.parse(localStorage.getItem(receiptKey)!)).not.toHaveProperty('submitted');
    } else
      expect(
        Object.keys(localStorage).some((key) =>
          key.startsWith('mitzo-local-first-command-outbox:'),
        ),
      ).toBe(true);
  },
);
