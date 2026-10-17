// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newAgentDefinition } from './agent-library';
import { getChatDraft, saveChatDraft } from './chat-drafts';
import { openAgentBuilderChat, markAgentBuilderAssigned } from './agent-builder-chat';
import { createTestStore } from '../test-utils/createTestStore';
import { createReviewedOutboxStorage } from './reviewed-outbox-storage';
import { discardChatDraft } from './discard-chat-draft';
import { apiFetch } from './api-fetch';
vi.mock('./api-fetch', async (original) => ({ ...(await original<object>()), apiFetch: vi.fn() }));
import type { AgentLibraryEditor } from './agent-library-working-copy';
const editor = (): AgentLibraryEditor => ({
  profileId: 'bob',
  definition: {
    ...newAgentDefinition(),
    name: 'Working Bob',
    descriptor: ' The architect ',
    instructions: 'First\n  second ',
  },
  expectedVersion: 2,
  baseRevision: 3,
  publishedRevision: 3,
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify({
          sessionId: decodeURIComponent(String(url).split('/')[3]),
          isHidden: false,
        }),
      ),
  );
});
it('opens one ordinary draft with an exact unsaved snapshot and no account override', async () => {
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(draft.settings.launch).toBeUndefined();
  expect(draft.settings.selection).toBeNull();
  expect(draft.contextBlocks).toEqual([]);
  expect(draft.text).toBe('Help me refine this agent.');
  const search = new URLSearchParams(draft.settings.search);
  expect(search.get('agentProfile')).toBe('mitzo-profile-builder');
  expect(search.get('agentProfileKind')).toBe('builtin');
  const source = draft.settings.sourceSnapshots![0];
  expect(source.kind).toBe('agent-library');
  expect(JSON.parse(source.content)).toMatchObject({
    source: {
      kind: 'draft',
      profileId: 'bob',
      baseRevision: 3,
      draftVersion: null,
      expectedVersion: 2,
    },
    definition: input.definition,
  });
  expect(await openAgentBuilderChat(input, true)).toBe(path);
  draft.text = 'My unfinished question';
  saveChatDraft(draft);
  expect(getChatDraft(draft.id)?.text).toBe('My unfinished question');
  expect(await openAgentBuilderChat(input, true)).toBe(path);
});
it('pins published provenance and opens changed edits independently', async () => {
  const input = editor();
  const path = await openAgentBuilderChat(input, false, 'a'.repeat(64));
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).source).toEqual({
    kind: 'published',
    profileId: 'bob',
    revision: 3,
    contentHash: 'a'.repeat(64),
  });
  expect(
    await openAgentBuilderChat(
      { ...input, definition: { ...input.definition, name: 'Newer Bob' } },
      true,
    ),
  ).not.toBe(path);
});
it('returns to the assigned real conversation without allocating a second draft', async () => {
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  markAgentBuilderAssigned(draft, 'assigned-session');
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/assigned-session');
});
it('reports storage failure before navigating', async () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw Error('full');
  };
  try {
    await expect(
      Promise.resolve().then(() => openAgentBuilderChat(editor(), true)),
    ).rejects.toThrow(/save|retain/i);
  } finally {
    Storage.prototype.setItem = original;
  }
});
it('uses the durable admission owner to recover a cold assignment and fences a second command', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    sessionId: null,
    clientMsgId: 'original-command',
    sourceSnapshots: draft.settings.sourceSnapshots,
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'duplicate-command' })).toBe(
    false,
  );
  expect(await openAgentBuilderChat(input, true)).toBe(path);
  agentBuilderCommandHandoff.assign('original-command', 'recovered-session', {
    kind: 'agent-library',
    revision: draft.settings.sourceSnapshots![0].revision,
  });
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/recovered-session');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'duplicate-command' })).toBe(
    false,
  );
});
it('retains a failed assignment for exact retry and releases only a definitive rejection', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    clientMsgId: 'native-command',
    payload: { sourceSnapshots: draft.settings.sourceSnapshots },
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw Error('full');
  };
  try {
    expect(() => agentBuilderCommandHandoff.assign('native-command', 'session')).toThrow();
  } finally {
    Storage.prototype.setItem = original;
  }
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(
    false,
  );
  agentBuilderCommandHandoff.reject('native-command');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(true);
});
it('keeps reviewed source and its draft identity when the user clears the opening question', async () => {
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  draft.text = '';
  expect(saveChatDraft(draft)).toBe(true);
  expect(getChatDraft(draft.id)?.settings.sourceSnapshots).toEqual(draft.settings.sourceSnapshots);
  expect(await openAgentBuilderChat(input, true)).toBe(path);
});
it('hands unfinished editor fields to Builder without normalizing them or demanding publication validity', async () => {
  const input = editor();
  input.definition.role = 'unfinished role ';
  input.definition.modelPolicyRole = ' ';
  input.definition.descriptor = ' '.repeat(90);
  input.definition.recipe = {
    version: 1,
    context: { include: [], sources: [] },
    skillRefs: [' ', ''],
    toolDefaults: { mode: 'read-only', preferredTools: [' ', ''] },
    compatibleProviders: [],
    reviewerTemplate: 'general',
  };
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).definition).toEqual(
    input.definition,
  );
});
it('keeps explicitly reviewed context pinned with the draft across Builder reentry', async () => {
  const input = editor();
  const context = '# Reviewed context\nExact  spaces and lines.\n';
  const path = await openAgentBuilderChat(input, true, undefined, context);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(JSON.parse(draft.settings.sourceSnapshots![0].content).reviewedContext).toBe(context);
  expect(await openAgentBuilderChat(input, true, undefined, context)).toBe(path);
});

it('starts a fresh ordinary draft only after assigned conversation removal is explicitly confirmed', async () => {
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  markAgentBuilderAssigned(draft, 'deleted-session');
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ sessionId: 'deleted-session', isHidden: true })),
  );
  const reopened = await openAgentBuilderChat(input, true);
  expect(apiFetch).toHaveBeenCalledWith('/api/sessions/deleted-session/meta');
  expect(reopened).not.toBe('/chat/deleted-session');
  expect(new URL(reopened, 'https://mitzo.example').searchParams.get('draft')).not.toBe(draft.id);
});
it.each(['404', 'network', 'malformed', 'wrong-identity', 'missing-visibility'] as const)(
  'keeps assigned ownership and blocks replacement on uncertain %s visibility',
  async (failure) => {
    const input = editor();
    const path = await openAgentBuilderChat(input, true);
    const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
    markAgentBuilderAssigned(draft, 'retained-session');
    const before = JSON.stringify(localStorage);
    vi.mocked(apiFetch).mockImplementation(async () => {
      if (failure === 'network') throw Error('offline');
      if (failure === '404') return new Response('{}', { status: 404 });
      if (failure === 'malformed') return new Response('{');
      if (failure === 'wrong-identity')
        return new Response(JSON.stringify({ sessionId: 'another', isHidden: true }));
      return new Response(JSON.stringify({ sessionId: 'retained-session' }));
    });
    await expect(Promise.resolve().then(() => openAgentBuilderChat(input, true))).rejects.toThrow(
      /verify|visibility|check/i,
    );
    expect(JSON.stringify(localStorage)).toBe(before);
  },
);
it('keeps the exact uncertain command fence when Drafts discards its source draft and Library recreates it', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    sessionId: null,
    clientMsgId: 'uncertain-command',
    sourceSnapshots: draft.settings.sourceSnapshots,
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  await discardChatDraft(draft);
  expect(getChatDraft(draft.id)).toBeNull();
  expect(await openAgentBuilderChat(input, true)).toBe(path);
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'duplicate-command' })).toBe(
    false,
  );
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  agentBuilderCommandHandoff.assign('uncertain-command', 'recovered-session');
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/recovered-session');
});
it('does not rebind a fresh source intent when an acknowledged deleted command retries after outbox retirement failed', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    sessionId: null,
    clientMsgId: 'old-command',
    sourceSnapshots: draft.settings.sourceSnapshots,
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  agentBuilderCommandHandoff.assign('old-command', 'deleted-session');
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ sessionId: 'deleted-session', isHidden: true })),
  );
  const fresh = await openAgentBuilderChat(input, true);
  expect(fresh).not.toBe('/chat/deleted-session');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'fresh-command' })).toBe(
    true,
  );
  expect(() =>
    agentBuilderCommandHandoff.assign('old-command', 'deleted-session', {
      kind: 'agent-library',
      revision: draft.settings.sourceSnapshots![0].revision,
    }),
  ).not.toThrow();
  expect(await openAgentBuilderChat(input, true)).toBe(fresh);
  agentBuilderCommandHandoff.assign('fresh-command', 'fresh-session');
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ sessionId: 'fresh-session', isHidden: false })),
  );
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/fresh-session');
});
it('completes an exact assignment after its durable receipt saved but its source mapping write failed', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const source = draft.settings.sourceSnapshots![0];
  expect(
    agentBuilderCommandHandoff.prepare({
      sessionId: null,
      clientMsgId: 'partial-command',
      sourceSnapshots: [source],
    }),
  ).toBe(true);
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (key === `mitzo-agent-builder-chat:${source.revision}`) throw Error('source storage full');
    return original.call(this, key, value);
  };
  try {
    expect(() => agentBuilderCommandHandoff.assign('partial-command', 'assigned-session')).toThrow(
      'source storage full',
    );
  } finally {
    Storage.prototype.setItem = original;
  }
  expect(
    JSON.parse(localStorage.getItem('mitzo-agent-builder-chat:command:partial-command')!),
  ).toEqual({ revision: source.revision, sessionId: 'assigned-session' });
  agentBuilderCommandHandoff.assign('partial-command', 'assigned-session');
  expect(await openAgentBuilderChat(input, true)).toBe('/chat/assigned-session');
});
it('does not let a legacy hint-only acknowledgement claim a fresh unsubmitted source intent', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const path = await openAgentBuilderChat(editor(), true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  expect(() =>
    agentBuilderCommandHandoff.assign('unowned-old-command', 'old-session', {
      kind: 'agent-library',
      revision: draft.settings.sourceSnapshots![0].revision,
    }),
  ).toThrow(/assignment changed/);
  expect(await openAgentBuilderChat(editor(), true)).toBe(path);
});
it('releases a recreated pending draft for a new command only after definitive rejection', async () => {
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const path = await openAgentBuilderChat(editor(), true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const command = {
    sessionId: null,
    clientMsgId: 'rejected-command',
    sourceSnapshots: draft.settings.sourceSnapshots,
  };
  expect(agentBuilderCommandHandoff.prepare(command)).toBe(true);
  await discardChatDraft(draft);
  await openAgentBuilderChat(editor(), true);
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(
    false,
  );
  agentBuilderCommandHandoff.reject('rejected-command');
  expect(agentBuilderCommandHandoff.prepare({ ...command, clientMsgId: 'new-command' })).toBe(true);
});

it('recovers the same actual reviewed outbox command after Drafts discard and cold store recreation', async () => {
  vi.useFakeTimers();
  const { agentBuilderCommandHandoff } = await import('./agent-builder-chat');
  const input = editor();
  const path = await openAgentBuilderChat(input, true);
  const draft = getChatDraft(new URL(path, 'https://mitzo.example').searchParams.get('draft')!)!;
  const commands: Record<string, unknown>[] = [];
  let accept = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/reviewed/send') {
      const command = JSON.parse(String(init?.body));
      commands.push(command);
      if (!accept) throw Error('Server accepted but acknowledgement was lost');
      return Response.json({
        accepted: true,
        clientMsgId: command.clientMsgId,
        sessionId: 'cold-recovered-session',
      });
    }
    return Response.json(url.endsWith('/meta') ? {} : []);
  });
  const cold = () =>
    createTestStore({
      transport: { fetch },
      reviewedSendConfig: {
        url: '/reviewed/send',
        storage: createReviewedOutboxStorage(localStorage, 'https://mitzo.example/reviewed/send'),
      },
      sendHandoff: agentBuilderCommandHandoff,
      initiallyAuthenticated: false,
    });
  const first = cold();
  first.getState().restoreAuthentication();
  first.getState().sendMessage(draft.text, {
    accountId: 'work',
    model: 'offline-fixture',
    agentProfile: { kind: 'builtin', profileId: 'mitzo-profile-builder', revision: 1 },
    sourceSnapshots: draft.settings.sourceSnapshots,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(commands).toHaveLength(1);
  first.getState().invalidateAuthentication();
  await discardChatDraft(draft);
  expect(await openAgentBuilderChat(input, true)).toBe(path);
  expect(
    agentBuilderCommandHandoff.prepare({ ...commands[0], clientMsgId: 'duplicate-after-discard' }),
  ).toBe(false);
  accept = true;
  const restored = cold();
  try {
    restored.getState().restoreAuthentication();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(new Set(commands.map((command) => command.clientMsgId)).size).toBe(1);
    expect(await openAgentBuilderChat(input, true)).toBe('/chat/cold-recovered-session');
  } finally {
    restored.getState().invalidateAuthentication();
  }
});
