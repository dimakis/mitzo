import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { V2HandlerContext } from '../ws-handler-v2.js';
import type { SessionSseRegistry } from '../session-sse-registry.js';
import type { LegacyNativeSource } from '../legacy-native-continuation.js';

const mocks = vi.hoisted(() => ({
  source: null as null | ((id: string) => LegacyNativeSource),
  load: vi.fn(),
  custody: vi.fn(),
  queue: vi.fn(),
  replay: vi.fn(),
  hasNative: vi.fn(() => false),
}));
vi.mock('../codex-chat-session.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getCodexConversationStore: () => ({ hasConversation: mocks.hasNative }),
}));
vi.mock('../legacy-native-continuation-routes.js', () => ({
  createLegacyNativeContinuationRouter: (deps: { source(id: string): LegacyNativeSource }) => {
    mocks.source = deps.source;
    return express.Router();
  },
}));
vi.mock('../responses-chat-session.js', () => ({
  getNativeResponsesStore: () => ({
    load: mocks.load,
    readOrdinaryCustody: mocks.custody,
    queue: mocks.queue,
  }),
}));
vi.mock('../chat.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  replayEventsToMessages: mocks.replay,
}));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  createOwnedLocalCodexEntryRouter: () => express.Router(),
  createOwnedOrdinaryWorkspaceCommandRouter: () => express.Router(),
  createOwnedCodexFirstCommandHandler: () => vi.fn(),
}));
import { mountApplicationChatRestTransport } from '../chat-rest-handler.js';

afterEach(() => vi.resetAllMocks());

function fixture() {
  const meta = {
    sessionId: 'legacy-source',
    initialPrompt: 'Develop Mitzo from within Mitzo',
    accountBinding: {
      accountId: 'work-fixture',
      accountLabel: 'Work fixture',
      provider: 'openai',
      model: 'luna-fixture',
      profileRevision: 'profile-fixture',
    },
  };
  const events = [{ seq: 1, type: 'user_message' }];
  const messages = [{ role: 'user', blocks: [{ blockType: 'text', content: meta.initialPrompt }] }];
  mocks.replay.mockReturnValue(messages);
  const ctx = {
    eventStore: {
      getSession: vi.fn(() => meta),
      getSessionEvents: vi.fn(() => events),
      getSessionRuntimeBinding: vi.fn(() => null),
    },
    sessionRegistry: { findBySessionId: vi.fn(() => undefined) },
  } as unknown as V2HandlerContext;
  mountApplicationChatRestTransport(express(), {} as SessionSseRegistry, ctx);
  return { meta, events, messages, read: () => mocks.source!('legacy-source') };
}

it('reads the public transcript of a pre-runtime chat with no private Responses row', () => {
  const f = fixture();
  expect(f.read()).toMatchObject({
    meta: f.meta,
    events: f.events,
    messages: f.messages,
    live: false,
  });
  expect(f.read().state).toBeUndefined();
  expect(mocks.queue).not.toHaveBeenCalled();
});

it('does not turn a private binding or history read failure into missing historical state', () => {
  const f = fixture();
  mocks.load.mockImplementation(() => {
    throw Error('Private history binding changed');
  });
  expect(f.read).toThrow('Private history binding changed');
});

it('refuses to migrate an already native pre-runtime chat after its owner closes', () => {
  const f = fixture();
  mocks.hasNative.mockReturnValueOnce(true);
  expect(f.read).toThrow(/already.*native Codex/i);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.replay).not.toHaveBeenCalled();
});

it('does not treat a failed native presence read as historical Responses evidence', () => {
  const f = fixture();
  mocks.hasNative.mockImplementationOnce(() => {
    throw Error('Native metadata unavailable');
  });
  expect(f.read).toThrow('Native metadata unavailable');
  expect(mocks.load).not.toHaveBeenCalled();
});
