// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { CollaborationApiClient } from '@mitzo/client';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
import {
  sharedConversationView,
  sharedPrompt,
  sharedReply,
  uuid,
} from '../../../../tests/fixtures/symposium-shared-conversation-data';
import { useConversationSending } from '../useConversationSending';
import { AUTH_LOST_EVENT } from '../../lib/api-fetch';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

it('consumes an exact prompt attachment after observing a lost accepted receipt without repeating delivery', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Reviewed prompt' });
  const snapshot = { snapshotId: uuid(94), sha256: 'a'.repeat(64) };
  const api = new CollaborationApiClient(vi.fn());
  vi.spyOn(api, 'recipientReadiness').mockImplementation(async (_group, sessionId) => ({
    collaborationId: view.collaborationId,
    sessionId,
    membershipRevision: view.membershipRevision,
    policySequence: view.policySequence,
    ready: true,
    reason: null,
  }));
  vi.spyOn(api, 'send').mockRejectedValue(Error('Accepted response lost'));
  const observed = vi.spyOn(api, 'observeSend').mockImplementation(async (_group, input) => ({
    message: {
      ...sharedPrompt,
      text: input.text,
      snapshot,
      responders: ['architect'],
      deliveries: [sharedPrompt.deliveries[0]],
    },
    terminal: true,
  }));
  const accepted = vi.fn((input) =>
    expect(getChatDraft(draft.id)!.collaborationSend!.input).toEqual(input),
  );
  const proof = () => 'login';
  const refresh = async () => view;
  const hook = renderHook(() =>
    useConversationSending({
      api,
      view,
      draftId: draft.id,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      responders: { kind: 'selected', sessionIds: ['architect'] },
      refresh,
      snapshot,
      onAccepted: accepted,
    }),
  );
  await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
  await act(async () => {
    expect(await hook.result.current.send('Reviewed prompt')).toBe(false);
  });
  const original = getChatDraft(draft.id)!.collaborationSend!.input;
  expect(original.snapshot).toEqual(snapshot);
  expect(accepted).not.toHaveBeenCalled();
  await act(async () => {
    await hook.result.current.check();
  });
  expect(accepted).toHaveBeenCalledExactlyOnceWith(original);
  expect(api.send).toHaveBeenCalledOnce();
  expect(observed.mock.calls.every(([, input]) => input.requestId === original.requestId)).toBe(
    true,
  );
  expect(getChatDraft(draft.id)!.collaborationSend).toBeUndefined();
});
it.each(['settled_status', 'late_success', 'late_failure'])(
  'never transfers old Stop state to a new same-owner request: %s',
  async (scenario) => {
    const view = sharedConversationView();
    const draft = createChatDraft();
    const original = {
      collaborationId: view.collaborationId,
      authScope: 'login',
      input: {
        requestId: uuid(96),
        expectedMembershipRevision: view.membershipRevision,
        expectedPolicySequence: view.policySequence,
        text: sharedPrompt.text,
        responders: { kind: 'selected' as const, sessionIds: ['architect'] },
        snapshot: null,
      },
    };
    saveChatDraft({ ...draft, text: 'Next draft stays editable', collaborationSend: original });
    let terminal = false;
    let release!: () => void;
    const api = new CollaborationApiClient(vi.fn());
    vi.spyOn(api, 'observeSend').mockImplementation(async () => ({
      message: sharedPrompt,
      terminal,
    }));
    vi.spyOn(api, 'recipientReadiness').mockResolvedValue({
      collaborationId: view.collaborationId,
      sessionId: 'architect',
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: true,
      reason: null,
    });
    vi.spyOn(api, 'stopSend').mockImplementation(async (_group, input) => {
      const old = input.requestId === original.input.requestId;
      if (old && scenario !== 'settled_status')
        await new Promise<void>((r) => {
          release = r;
        });
      if (old && scenario === 'late_failure') throw Error('Old Stop response lost');
      return {
        requestId: input.requestId,
        recipients: [
          {
            sessionId: 'architect',
            deliveryId: sharedPrompt.deliveries[0].deliveryId,
            status: 'requested',
          },
        ],
      };
    });
    vi.spyOn(api, 'send').mockImplementation(async (_group, input) => ({
      ...sharedPrompt,
      text: input.text,
      responders: ['architect'],
      deliveries: [sharedPrompt.deliveries[0]],
    }));
    const proof = () => 'login';
    const refresh = vi.fn(async () => view);
    const hook = renderHook(() =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders: original.input.responders,
        refresh,
      }),
    );
    await act(async () => {}); // Finish the initial observational read before the control race.
    let stopped!: Promise<void>;
    act(() => {
      stopped = hook.result.current.stop();
    });
    if (scenario === 'settled_status')
      await act(async () => {
        await stopped;
      });
    terminal = true;
    await act(async () => {
      await hook.result.current.check();
    });
    await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
    await act(async () => {
      expect(await hook.result.current.send('A separate new prompt')).toBe(true);
    });
    const next = getChatDraft(draft.id)!.collaborationSend!;
    expect(next.input.requestId).not.toBe(original.input.requestId);
    expect(next.stopRequested).toBeUndefined();
    expect(hook.result.current.stopStatus).toBeUndefined();
    if (scenario !== 'settled_status') {
      await act(async () => {
        await hook.result.current.stop();
      });
      expect(api.stopSend).toHaveBeenNthCalledWith(2, view.collaborationId, next.input);
      expect(hook.result.current.stopStatus).toContain('Stop requested');
      await act(async () => {
        release();
        await stopped;
      });
      expect(hook.result.current.stopStatus).toContain('Stop requested');
    } else expect(hook.result.current.stopStatus).toBeUndefined();
    expect(hook.result.current.error).toBeUndefined();
    expect(getChatDraft(draft.id)!.collaborationSend).toEqual(
      scenario === 'settled_status' ? next : { ...next, stopRequested: true },
    );
  },
);

it('retains uncertain Stop intent across remount without replaying send or control', async () => {
  const view = sharedConversationView();
  const original = {
    collaborationId: view.collaborationId,
    authScope: 'login',
    input: {
      requestId: uuid(97),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: sharedPrompt.text,
      responders: { kind: 'selected' as const, sessionIds: ['architect'] },
      snapshot: null,
    },
  };
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Next draft stays editable', collaborationSend: original });
  let controls = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).not.toMatch(/\/messages$/);
    expect(JSON.parse(init!.body as string)).toEqual(original.input);
    if (url.endsWith('/messages/stop')) {
      controls++;
      expect(getChatDraft(draft.id)?.collaborationSend?.stopRequested).toBe(true);
      if (controls === 1) throw Error('Lost Stop response');
      return Response.json({
        requestId: original.input.requestId,
        recipients: [
          {
            sessionId: 'architect',
            deliveryId: sharedPrompt.deliveries[0].deliveryId,
            status: 'uncertain',
          },
        ],
      });
    }
    expect(url).toMatch(/\/messages\/observe$/);
    return Response.json({ message: sharedPrompt, terminal: false });
  });
  const options = {
    api: new CollaborationApiClient(fetch),
    view,
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: () => 'login',
    responders: { kind: 'selected' as const, sessionIds: ['architect'] },
    refresh: vi.fn(async () => view),
  };
  const first = renderHook(() => useConversationSending(options));
  await act(async () => {
    await first.result.current.stop();
  });
  expect(first.result.current.stopStatus).toContain('uncertain');
  const retained = { ...original, stopRequested: true };
  expect(getChatDraft(draft.id)?.collaborationSend).toEqual(retained);
  first.unmount();
  const next = renderHook(() => useConversationSending(options));
  await act(async () => {
    await next.result.current.check();
  });
  expect(controls).toBe(1);
  expect(next.result.current.pending).toEqual(retained);
  await act(async () => {
    await next.result.current.stop();
  });
  expect(controls).toBe(2);
  expect(getChatDraft(draft.id)?.text).toBe('Next draft stays editable');
  expect(getChatDraft(draft.id)?.collaborationSend).toEqual(retained);
});

it('defers login recovery to the application while refusing sends and readiness reads without its proof', async () => {
  const view = sharedConversationView();
  const draft = { ...createChatDraft(), text: 'Retain my ordinary draft' };
  saveChatDraft(draft);
  let verified: string | undefined;
  const proof = () => verified;
  const fetch = vi.fn(async () =>
    Response.json({
      collaborationId: view.collaborationId,
      sessionId: 'reviewer',
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: true,
      reason: null,
    }),
  );
  const api = new CollaborationApiClient(fetch);
  const refresh = vi.fn(async () => view);
  const { result } = renderHook(() =>
    useConversationSending({
      api,
      view,
      draftId: draft.id,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      responders: { kind: 'selected', sessionIds: ['reviewer'] },
      refresh,
    }),
  );
  expect(result.current.disabledReason).toBe('Conversation unavailable.');
  await act(async () => {
    await result.current.check();
    expect(await result.current.send('Do not send')).toBe(false);
  });
  expect(fetch).not.toHaveBeenCalled();
  verified = 'login';
  await act(async () => {
    await result.current.check();
  });
  expect(result.current.disabledReason).toBeUndefined();
  act(() => {
    verified = undefined;
    window.dispatchEvent(new Event(AUTH_LOST_EVENT));
  });
  expect(result.current.disabledReason).toBe('Conversation unavailable.');
  await act(async () => {
    expect(await result.current.send('Still do not send')).toBe(false);
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
});

it('settles an oversized prompt as a visible refusal without retaining or dispatching it', async () => {
  const view = sharedConversationView();
  const draft = { ...createChatDraft(), text: 'Keep this draft' };
  saveChatDraft(draft);
  const fetch = vi.fn(async () =>
    Response.json({
      collaborationId: view.collaborationId,
      sessionId: 'reviewer',
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: true,
      reason: null,
    }),
  );
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const hook = renderHook(() =>
    useConversationSending({
      api,
      view,
      draftId: draft.id,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      responders: { kind: 'selected', sessionIds: ['reviewer'] },
      refresh,
    }),
  );
  await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
  await act(async () => expect(await hook.result.current.send('x'.repeat(100001))).toBe(false));
  expect(hook.result.current.error).toBeTruthy();
  expect(hook.result.current.pending).toBeUndefined();
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
  expect(fetch).toHaveBeenCalledOnce();
});
it('requires server readiness and preserves one uncertain request across remount without resending', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Keep this prompt' });
  let ready = false;
  const mutations: unknown[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/recipients/'))
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId: 'reviewer',
        membershipRevision: view.membershipRevision,
        policySequence: view.policySequence,
        ready,
        reason: ready ? null : 'Review this participant.',
      });
    if (url.endsWith('/messages/observe')) return Response.json({ message: null });
    if (url.endsWith('/messages')) {
      mutations.push(JSON.parse(String(init?.body)));
      throw Error('Lost response');
    }
    throw Error('Unexpected request');
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const props = {
    api,
    view,
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: proof,
    responders: { kind: 'selected' as const, sessionIds: ['reviewer'] },
    refresh: vi.fn(async () => {}),
  };
  const first = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(first.result.current.disabledReason).toBe('Review this participant.'));
  await act(async () => {
    expect(await first.result.current.send('Keep this prompt')).toBe(false);
  });
  expect(mutations).toHaveLength(0);
  ready = true;
  await act(async () => {
    await first.result.current.check();
  });
  await waitFor(() => expect(first.result.current.disabledReason).toBeUndefined());
  await act(async () => {
    expect(await first.result.current.send('Keep this prompt')).toBe(false);
  });
  expect(mutations).toHaveLength(1);
  expect(getChatDraft(draft.id)?.text).toBe('Keep this prompt');
  first.unmount();
  const second = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(second.result.current.disabledReason).toMatch(/original|uncertain/i));
  await act(async () => {
    await second.result.current.check();
  });
  await act(async () => {
    expect(await second.result.current.send('Changed retry')).toBe(false);
  });
  expect(mutations).toHaveLength(1);
});

it('checks a newly selected recipient while an older readiness request is still pending', async () => {
  const view = sharedConversationView();
  const draft = createChatDraft();
  saveChatDraft({ ...draft, text: 'Next prompt' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn(async (url: string) => {
    const old = url.endsWith('/reviewer');
    if (old) await held;
    return Response.json({
      collaborationId: view.collaborationId,
      sessionId: old ? 'reviewer' : 'reader',
      membershipRevision: view.membershipRevision,
      policySequence: view.policySequence,
      ready: !old,
      reason: old ? 'Old recipient is unavailable.' : null,
    });
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const hook = renderHook(
    ({ recipient }) =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders: { kind: 'selected', sessionIds: [recipient] },
        refresh,
      }),
    { initialProps: { recipient: 'reviewer' } },
  );
  try {
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    hook.rerender({ recipient: 'reader' });
    await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
  } finally {
    await act(async () => release());
  }
  expect(hook.result.current.disabledReason).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  'checks readiness after terminal recovery with no visible reply=%s',
  async (empty) => {
    const view = sharedConversationView();
    if (empty) view.messages = [sharedPrompt];
    const draft = createChatDraft();
    saveChatDraft({
      ...draft,
      text: 'Next prompt',
      collaborationSend: {
        collaborationId: view.collaborationId,
        authScope: 'login',
        input: {
          requestId: uuid(90),
          expectedMembershipRevision: view.membershipRevision,
          expectedPolicySequence: view.policySequence,
          text: sharedPrompt.text,
          responders: { kind: 'selected', sessionIds: ['architect'] },
          snapshot: null,
        },
      },
    });
    expect(getChatDraft(draft.id)?.collaborationSend).toBeDefined();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/messages/observe'))
        return Response.json({
          message: {
            ...sharedPrompt,
            responders: ['architect'],
            readers: ['architect'],
            settings: { architect: sharedPrompt.settings.architect },
            deliveries: sharedPrompt.deliveries.filter((d) => d.sessionId === 'architect'),
          },
          terminal: true,
        });
      if (url.includes('/recipients/'))
        return Response.json({
          collaborationId: view.collaborationId,
          sessionId: 'architect',
          membershipRevision: view.membershipRevision,
          policySequence: view.policySequence,
          ready: true,
          reason: null,
        });
      throw Error('Recovery must not dispatch another prompt');
    });
    const api = new CollaborationApiClient(fetch);
    const proof = () => 'login';
    const refresh = vi.fn(async () => view);
    const hook = renderHook(() =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders: { kind: 'selected', sessionIds: ['architect'] },
        refresh,
      }),
    );
    await waitFor(() => expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined());
    await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it.each(['default', 'all', 'selected'] as const)(
  'retains %s intent and verifies readiness and receipts for every responder',
  async (kind) => {
    const view = sharedConversationView();
    view.policies.find((p) => p.sessionId === 'reviewer')!.repliesByDefault = true;
    const ids = kind === 'all' ? view.participantSessionIds : ['architect', 'reviewer'];
    const responders = kind === 'selected' ? { kind, sessionIds: ids } : { kind };
    const draft = createChatDraft();
    saveChatDraft({ ...draft, text: 'Answer independently' });
    const submissions: unknown[] = [];
    const readiness: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/recipients/')) {
        const sessionId = url.split('/').at(-1)!;
        readiness.push(sessionId);
        return Response.json({
          collaborationId: view.collaborationId,
          sessionId,
          membershipRevision: view.membershipRevision,
          policySequence: view.policySequence,
          ready: true,
          reason: null,
        });
      }
      if (url.endsWith('/messages')) {
        const input = JSON.parse(String(init?.body));
        submissions.push(input);
        return Response.json({
          ...sharedPrompt,
          text: input.text,
          responders: ids,
          deliveries: sharedPrompt.deliveries.map((d) => ({
            ...d,
            purpose: ids.includes(d.sessionId) ? 'reply' : 'context',
            status: 'queued',
          })),
        });
      }
      throw Error('Unexpected request');
    });
    const api = new CollaborationApiClient(fetch);
    const proof = () => 'login';
    const refresh = vi.fn(async () => view);
    const hook = renderHook(() =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders,
        refresh,
      }),
    );
    await waitFor(() => expect(hook.result.current.disabledReason).toBeUndefined());
    expect(readiness).toEqual(ids);
    await act(async () =>
      expect(await hook.result.current.send('Answer independently')).toBe(true),
    );
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ responders });
    expect(getChatDraft(draft.id)?.collaborationSend?.input.responders).toEqual(responders);
    expect(hook.result.current.pending).toBeDefined();
  },
);

it('keeps partial replies and original Defaults recovery until all reply recipients settle', async () => {
  const view = sharedConversationView();
  view.policySequence = 1;
  for (const policy of view.policies) policy.repliesByDefault = policy.sessionId === 'reader';
  const draft = createChatDraft();
  const original = {
    requestId: uuid(91),
    expectedMembershipRevision: 1,
    expectedPolicySequence: 0,
    text: sharedPrompt.text,
    responders: { kind: 'default' as const },
    snapshot: null,
  };
  saveChatDraft({
    ...draft,
    collaborationSend: {
      collaborationId: view.collaborationId,
      authScope: 'login',
      input: original,
    },
  });
  let completed = false;
  const observations: unknown[] = [];
  const readiness: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/messages/observe')) {
      observations.push(JSON.parse(String(init?.body)));
      return Response.json({
        message: {
          ...sharedPrompt,
          deliveries: sharedPrompt.deliveries.map((d) =>
            completed && d.sessionId === 'reviewer' ? { ...d, status: 'failed' } : d,
          ),
        },
        terminal: completed,
      });
    }
    if (url.includes('/recipients/')) {
      const sessionId = url.split('/').at(-1)!;
      readiness.push(sessionId);
      return Response.json({
        collaborationId: view.collaborationId,
        sessionId,
        membershipRevision: 1,
        policySequence: 1,
        ready: true,
        reason: null,
      });
    }
    throw Error('Recovery must never submit or replay a command');
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const props = {
    api,
    view,
    draftId: draft.id,
    authScope: 'login',
    getVerifiedAuthScope: proof,
    responders: { kind: 'default' as const },
    refresh,
  };
  const first = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(getChatDraft(draft.id)?.collaborationSend?.input).toEqual(original);
  expect(first.result.current.disabledReason).toMatch(/original request/);
  expect(view.messages).toContainEqual(sharedReply);
  expect(readiness).toEqual([]);
  first.unmount();
  const recovered = renderHook(() => useConversationSending(props));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(getChatDraft(draft.id)?.collaborationSend).toBeDefined();
  completed = true;
  await act(async () => recovered.result.current.check());
  expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined();
  expect(recovered.result.current.disabledReason).toBeUndefined();
  expect(readiness).toEqual(['reader']);
  expect(observations).toEqual([original, original, original, original]);
});

it('requires every resolved recipient to be ready before accepting Defaults', async () => {
  const view = sharedConversationView();
  view.policies.find((p) => p.sessionId === 'reviewer')!.repliesByDefault = true;
  const draft = createChatDraft();
  saveChatDraft(draft);
  const fetch = vi.fn(async (url: string) => {
    if (!url.includes('/recipients/')) throw Error('No send is authorized by partial readiness');
    const sessionId = url.split('/').at(-1)!;
    return Response.json({
      collaborationId: view.collaborationId,
      sessionId,
      membershipRevision: 1,
      policySequence: 0,
      ready: sessionId === 'architect',
      reason: sessionId === 'architect' ? null : 'Reviewer needs attention.',
    });
  });
  const api = new CollaborationApiClient(fetch);
  const proof = () => 'login';
  const refresh = vi.fn(async () => view);
  const hook = renderHook(() =>
    useConversationSending({
      api,
      view,
      draftId: draft.id,
      authScope: 'login',
      getVerifiedAuthScope: proof,
      responders: { kind: 'default' },
      refresh,
    }),
  );
  await waitFor(() => expect(hook.result.current.disabledReason).toBe('Reviewer needs attention.'));
  await act(async () => expect(await hook.result.current.send('Do not send')).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined();
});

it.each(['visible_text', 'revoked_during_refresh'] as const)(
  'retains the original until renewed authoritative settlement (%s)',
  async (scenario) => {
    const view = sharedConversationView();
    const message = structuredClone(sharedPrompt);
    view.messages = [
      message,
      sharedReply,
      {
        ...sharedReply,
        messageId: uuid(92),
        projectionId: uuid(93),
        author: { sessionId: 'reviewer' },
        source: {
          ...sharedReply.source!,
          conversationId: 'reviewer',
          commandId: 'ordinary-reviewer',
        },
        replyToDeliveryId: message.deliveries[1].deliveryId,
      },
    ];
    const draft = createChatDraft();
    const input = {
      requestId: uuid(94),
      expectedMembershipRevision: 1,
      expectedPolicySequence: 0,
      text: message.text,
      responders: { kind: 'selected' as const, sessionIds: message.responders },
      snapshot: null,
    };
    saveChatDraft({
      ...draft,
      text: 'Next draft',
      collaborationSend: { collaborationId: view.collaborationId, authScope: 'login', input },
    });
    let terminal = scenario === 'revoked_during_refresh';
    let revoke = scenario === 'revoked_during_refresh';
    const observations: unknown[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/messages/observe')) {
        observations.push(JSON.parse(String(init?.body)));
        return Response.json({ message, terminal });
      }
      if (url.includes('/recipients/'))
        return Response.json({
          collaborationId: view.collaborationId,
          sessionId: url.split('/').at(-1),
          membershipRevision: 1,
          policySequence: 0,
          ready: true,
          reason: null,
        });
      throw Error('Settlement cannot submit or replay a command');
    });
    const api = new CollaborationApiClient(fetch);
    const proof = () => 'login';
    const refresh = vi.fn(async () => {
      if (revoke) {
        revoke = false;
        terminal = false;
        message.deliveries[0].outcome = 'uncertain';
      }
      return view;
    });
    const hook = renderHook(() =>
      useConversationSending({
        api,
        view,
        draftId: draft.id,
        authScope: 'login',
        getVerifiedAuthScope: proof,
        responders: input.responders,
        refresh,
      }),
    );
    await waitFor(() => expect(observations).toHaveLength(scenario === 'visible_text' ? 1 : 2));
    expect(getChatDraft(draft.id)?.collaborationSend?.input).toEqual(input);
    expect(hook.result.current.disabledReason).toMatch(/original request/);
    terminal = true;
    await act(async () => hook.result.current.check());
    expect(getChatDraft(draft.id)?.collaborationSend).toBeUndefined();
    expect(hook.result.current.disabledReason).toBeUndefined();
    for (const observed of observations) expect(observed).toEqual(input);
  },
);
