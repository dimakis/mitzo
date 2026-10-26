import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import express, { type Router, type RequestHandler } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMeta } from '@mitzo/protocol';
import { NativeResponsesStore } from '../native-responses-store.js';
import {
  reviewLegacyNativeContinuation,
  type LegacyNativeSource,
  type LegacyNativeReview,
} from '../legacy-native-continuation.js';
import { createLegacyNativeContinuationRouter } from '../legacy-native-continuation-routes.js';

const auth = vi.hoisted(() => ({ id: 'operator', current: true }));
vi.mock('../auth.js', () => ({
  operatorAuthMiddleware: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.authSession = { id: auth.id, expiresAt: Date.now() + 60_000 };
    next();
  },
  isAuthSessionCurrent: () => auth.current,
}));
vi.mock('../connections-router.js', () => ({
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const binding = {
  accountId: 'work',
  accountLabel: 'Work API',
  provider: 'openai' as const,
  model: 'supported-model',
  profileRevision: 'pinned-profile',
};
const command = () => ({
  runOn: 'local',
  repositoryWorkspaceId: '507565e3-df2b-4266-98a9-3c4b6ee5a2f9',
  clientMsgId: 'new-command',
  capabilityRevision: 'current-native-capabilities',
  runtime: {
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: 'codex',
    targetId: 'mac',
    mode: 'ask',
  },
  selection: {
    version: 1,
    agent: { kind: 'builtin', profileId: 'mitzo:default', revision: 1 },
    context: { source: 'none', revision: null },
    permission: { mode: 'ask', revision: 0 },
    model: binding.model,
    thinking: null,
  },
  payload: {
    text: 'Inspect current files and explain what remains; do not repeat earlier changes.',
  },
});
const source = (): LegacyNativeSource => ({
  meta: {
    sessionId: 'retained-source',
    accountBinding: binding,
    selectedModel: binding.model,
    reasoningEffort: null,
    mode: 'ask',
    isHidden: false,
    executionPhase: 'TERMINAL',
    executionTerminalReason: 'completed',
    initialPrompt: 'Earlier request',
  } as SessionMeta,
  runtime: {
    version: 2,
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: { implementation: 'responses' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'old-target' },
  },
  state: {
    status: 'idle',
    history: [{ role: 'user', content: 'PRIVATE HISTORY MUST STAY' }],
    checkpoint: {
      accountId: 'work',
      model: binding.model,
      history: [],
      input: [{ type: 'reasoning', encrypted_content: 'PRIVATE CHECKPOINT' }],
    },
  },
  events: [{ seq: 1, type: 'user_message' }],
  live: false,
  pendingCommandIds: ['retained-queued-command'],
  hasActiveCommand: false,
  messages: [
    { role: 'user', blocks: [{ blockType: 'text', content: 'Earlier request' }] },
    {
      role: 'assistant',
      blocks: [
        { blockType: 'text', content: 'Earlier visible answer' },
        { blockType: 'tool_use', content: 'SECRET TOOL INPUT' },
        { blockType: 'thinking', content: 'PRIVATE REASONING' },
      ],
    },
  ],
});

describe('deliberate linked native continuation', () => {
  let directory: string;
  let store: NativeResponsesStore;
  let current: LegacyNativeSource;
  let app: Router;
  let admit: Mock<RequestHandler>;
  let commandState: 'consumed' | 'uncertain' | undefined;
  const openStore = () => new NativeResponsesStore(join(directory, 'responses.db'));
  beforeEach(() => {
    auth.id = 'operator';
    auth.current = true;
    directory = mkdtempSync(join(tmpdir(), 'mitzo-linked-native-'));
    store = openStore();
    current = source();
    commandState = undefined;
    store.save(current.meta.sessionId, binding, current.state!);
    admit = vi.fn<RequestHandler>(async (req, res) => {
      commandState = 'consumed';
      res.status(202).json({ ok: true, state: 'consumed', dispatched: true, command: req.body });
    });
    app = express.Router().use(
      '/sessions/:id/native-continuation',
      createLegacyNativeContinuationRouter({
        store: () => store,
        source: (id) => {
          if (id !== current.meta.sessionId) throw Error('Unavailable');
          return current;
        },
        hasSession: (id) => id === current.meta.sessionId,
        commandState: () => commandState,
        admit,
      }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function preview(): Promise<LegacyNativeReview> {
    const response = await invoke('/sessions/retained-source/native-continuation/preview', {
      command: command(),
    });
    expect(response.status).toBe(200);
    return response.body as unknown as LegacyNativeReview;
  }
  const invoke = (url: string, body: unknown, method = 'POST') =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      let status = 200;
      const req = { method, url, headers: {}, body } as express.Request;
      const responseState = { headersSent: false };
      const res = {
        locals: {},
        get headersSent() {
          return responseState.headersSent;
        },
        status(code: number) {
          status = code;
          return this;
        },
        set() {
          return this;
        },
        json(value: unknown) {
          responseState.headersSent = true;
          resolve({ status, body: value as Record<string, unknown> });
          return this;
        },
      } as unknown as express.Response;
      (app as Router & { handle: RequestHandler }).handle(req, res, (error) =>
        reject(error ?? Error('Unhandled route')),
      );
    });
  const commit = (reviewHash: string, extra = {}) =>
    invoke('/sessions/retained-source/native-continuation/commit', {
      reviewHash,
      acknowledgeUncertainOutcomes: false,
      acknowledgeSelectionChange: false,
      ...extra,
    });

  it('reviews exact public context and sends the separate new request through ordinary admission', async () => {
    const review = await preview();
    expect(admit).not.toHaveBeenCalled();
    expect(review.nativeSessionId).not.toBe(current.meta.sessionId);
    expect(review.retainedPendingCommands).toBe(1);
    expect(review.omittedNonTextBlocks).toBe(2);
    expect(review.command.payload.text).toContain('Earlier visible answer');
    expect(review.command.payload.text).toContain('Do not repeat any earlier request');
    for (const secret of [
      'PRIVATE HISTORY',
      'PRIVATE CHECKPOINT',
      'SECRET TOOL INPUT',
      'PRIVATE REASONING',
      'retained-queued-command',
    ])
      expect(JSON.stringify(review)).not.toContain(secret);
    const response = await commit(review.reviewHash);
    expect(response.status).toBe(202);
    expect(response.body.command).toEqual(review.command);
    expect(admit).toHaveBeenCalledOnce();
    expect(store.load(current.meta.sessionId, binding)).toEqual(current.state);
    expect(store.readLegacyNativeLink(review.reviewHash, auth.id).state).toBe('consumed');
    expect(store.listLegacyNativeLinks(current.meta.sessionId, auth.id)).toEqual([
      expect.objectContaining({
        sourceSessionId: current.meta.sessionId,
        nativeSessionId: review.nativeSessionId,
        state: 'consumed',
      }),
    ]);
    expect(store.listLegacyNativeLinks(review.nativeSessionId, auth.id)).toHaveLength(1);
    expect(store.listLegacyNativeLinks(current.meta.sessionId, 'another-login')).toEqual([]);
  });
  it('reviews an older transcript without private state and requires uncertainty acknowledgement before admission', async () => {
    current.runtime = undefined;
    delete (current as Partial<LegacyNativeSource>).state;
    current.pendingCommandIds = [];
    current.hasActiveCommand = false;
    const review = await preview();
    expect(review.uncertainOutcomes).toBe(true);
    expect(review.historicalStateUnavailable).toBe(true);
    expect(review.command.payload.text).toContain('pending commands: unknown');
    expect(review.command.payload.text).toContain('Earlier visible answer');
    expect(review.command.payload.text).toContain('Do not repeat any earlier request');
    expect((await commit(review.reviewHash)).status).toBe(409);
    expect(admit).not.toHaveBeenCalled();
    expect(
      (
        await commit(review.reviewHash, {
          acknowledgeUncertainOutcomes: true,
          acknowledgeSelectionChange: true,
        })
      ).status,
    ).toBe(202);
    expect(admit).toHaveBeenCalledOnce();
    expect(current.state).toBeUndefined();
  });
  it('invalidates a transcript-only review if private history later appears', async () => {
    current.runtime = undefined;
    const retained = current.state;
    current.state = undefined;
    const review = await preview();
    current.state = retained;
    expect(
      (
        await commit(review.reviewHash, {
          acknowledgeUncertainOutcomes: true,
          acknowledgeSelectionChange: true,
        })
      ).status,
    ).toBe(409);
    expect(admit).not.toHaveBeenCalled();
  });
  it('refuses a transcript-only continuation when no visible conversation remains', async () => {
    current.runtime = undefined;
    current.state = undefined;
    current.messages = [];
    expect(
      (
        await invoke('/sessions/retained-source/native-continuation/preview', {
          command: command(),
        })
      ).status,
    ).toBe(409);
  });
  it('refuses malformed existing private history rather than treating it as absent legacy history', async () => {
    current.runtime = undefined;
    current.state = { status: 'interrupted' } as LegacyNativeSource['state'];
    expect(
      (
        await invoke('/sessions/retained-source/native-continuation/preview', {
          command: command(),
        })
      ).status,
    ).toBe(409);
    expect(admit).not.toHaveBeenCalled();
  });
  it('does not continue an explicitly bound runtime whose private state has disappeared', async () => {
    delete (current as Partial<LegacyNativeSource>).state;
    expect(
      (
        await invoke('/sessions/retained-source/native-continuation/preview', {
          command: command(),
        })
      ).status,
    ).toBe(409);
    expect(admit).not.toHaveBeenCalled();
  });
  it('observes an accepted lost reply across restart without another native dispatch', async () => {
    const review = await preview();
    await commit(review.reviewHash);
    store.close();
    store = openStore();
    const retry = await commit(review.reviewHash);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({
      sessionId: review.nativeSessionId,
      state: 'consumed',
      dispatched: false,
    });
    expect(admit).toHaveBeenCalledOnce();
  });
  it.each(['expired', 'stale'])(
    'can retire an unclaimed %s review without leaving a commit replay path',
    async (reason) => {
      const review = await preview();
      if (reason === 'expired') {
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
      } else current.events.push({ seq: 9 });
      expect((await commit(review.reviewHash)).status).toBe(409);
      const lineage = await invoke(
        '/sessions/retained-source/native-continuation/',
        undefined,
        'GET',
      );
      expect(lineage.body.links).toContainEqual(
        expect.objectContaining({
          reviewHash: review.reviewHash,
          state: 'reviewed',
          canReviewAgain: true,
        }),
      );
      const discarded = await invoke('/sessions/retained-source/native-continuation/discard', {
        reviewHash: review.reviewHash,
      });
      expect(discarded.status).toBe(200);
      expect(discarded.body).toMatchObject({ reviewHash: review.reviewHash, state: 'discarded' });
      expect((await commit(review.reviewHash)).status).toBe(409);
      expect(admit).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    },
  );
  it('preserves uncertain native admission without replay even after reconnect', async () => {
    admit.mockImplementationOnce(async () => {
      throw Error('Lost native acceptance');
    });
    const review = await preview();
    expect((await commit(review.reviewHash)).status).toBe(409);
    store.close();
    store = openStore();
    expect((await commit(review.reviewHash)).body).toMatchObject({
      state: 'uncertain',
      dispatched: false,
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(store.load(current.meta.sessionId, binding)).toEqual(current.state);
  });
  it.each(['uncertain', 'consumed'] as const)(
    'never discards a %s native command',
    async (state) => {
      const review = await preview();
      store.claimLegacyNativeLink(review.reviewHash, auth.id);
      if (state === 'consumed') store.completeLegacyNativeLink(review.reviewHash, auth.id);
      commandState = state;
      const lineage = await invoke(
        '/sessions/retained-source/native-continuation/',
        undefined,
        'GET',
      );
      expect(lineage.body.links).toContainEqual(
        expect.objectContaining({ reviewHash: review.reviewHash, canReviewAgain: false }),
      );
      expect(
        (
          await invoke('/sessions/retained-source/native-continuation/discard', {
            reviewHash: review.reviewHash,
          })
        ).status,
      ).toBe(409);
      expect(store.readLegacyNativeLink(review.reviewHash, auth.id).state).toBe(state);
      expect(admit).not.toHaveBeenCalled();
    },
  );
  it('requires an explicit acknowledgement for unknown historical effects, never clears them', async () => {
    current.state!.status = 'interrupted';
    current.hasActiveCommand = true;
    const review = await preview();
    expect(review.uncertainOutcomes).toBe(true);
    expect((await commit(review.reviewHash)).status).toBe(409);
    expect(admit).not.toHaveBeenCalled();
    expect((await commit(review.reviewHash, { acknowledgeUncertainOutcomes: true })).status).toBe(
      202,
    );
    expect(current.state!.status).toBe('interrupted');
  });
  it.each(['state', 'events', 'binding', 'live'] as const)(
    'rejects stale %s evidence before dispatch',
    async (field) => {
      const review = await preview();
      if (field === 'state') current.state!.history.push({ role: 'assistant', content: 'Changed' });
      if (field === 'events') current.events.push({ seq: 2 });
      if (field === 'binding')
        current.meta.accountBinding = { ...binding, profileRevision: 'changed' };
      if (field === 'live') current.live = true;
      expect((await commit(review.reviewHash)).status).toBe(409);
      expect(admit).not.toHaveBeenCalled();
    },
  );
  it('binds a review to the current operator and exact source', async () => {
    const review = await preview();
    auth.id = 'other-login';
    expect((await commit(review.reviewHash)).status).toBe(409);
    expect(admit).not.toHaveBeenCalled();
    auth.id = 'operator';
    auth.current = false;
    expect((await commit(review.reviewHash)).status).toBe(403);
  });
  it('refuses another account or target location and requires review of explicit native selection changes', async () => {
    const changedAccount = command();
    changedAccount.runtime.account.accountId = 'other';
    expect(() => reviewLegacyNativeContinuation(current, { command: changedAccount })).toThrow(
      'original account',
    );
    const changed = command();
    changed.selection.model = 'another-supported-model';
    changed.runtime.targetId = 'reviewed-native-target';
    const review = reviewLegacyNativeContinuation(current, { command: changed });
    expect(review.selectionChanged).toBe(true);
    expect(review.sourceSelection).toMatchObject({ model: binding.model, targetId: 'mac' });
    store.saveLegacyNativeReview(review, auth.id);
    expect((await commit(review.reviewHash)).status).toBe(409);
    expect((await commit(review.reviewHash, { acknowledgeSelectionChange: true })).status).toBe(
      202,
    );
  });
  it('returns the exact bounded context and reports omitted content', () => {
    current.messages[0].blocks[0].content = 'old'.repeat(30_000);
    const review = reviewLegacyNativeContinuation(current, { command: command() });
    expect(review.context.length).toBe(48_000);
    expect(review.omittedEarlierCharacters).toBeGreaterThan(0);
    expect(review.command.payload.text).toContain(JSON.stringify(review.context));
  });
});
