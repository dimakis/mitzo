import { afterEach, expect, it, vi } from 'vitest';
import { GoogleAuth } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const services = vi.hoisted(() => ({
  authId: '',
  workspace: undefined as unknown,
  library: undefined as unknown,
  manager: { manages: () => true, resolveKey: vi.fn(async () => 'offline-exact-key') },
}));
vi.mock('../repository-workspace-runtime.js', async (original) => ({
  ...(await original<object>()),
  getRepositoryWorkspaces: () => services.workspace,
}));
vi.mock('../agent-library-runtime.js', async (original) => ({
  ...(await original<object>()),
  getAgentLibrary: () => services.library,
}));
vi.mock('../connections-runtime.js', () => {
  const runtime = { openAIEnrollmentAuthority: services.manager };
  return { getConnectionsRuntime: () => runtime };
});
vi.mock('../auth.js', async (original) => ({
  ...(await original<object>()),
  hasPersistentRevocationAuthority: () => true,
  operatorAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../connections-router.js', async (original) => ({
  ...(await original<object>()),
  requireSameOriginJson: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../transport-auth-ownership.js', async (original) => ({
  ...(await original<object>()),
  liveTransportAuthSessionId: () => services.authId,
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    throw Error('No alternate SDK');
  },
}));
vi.mock('../account-use-store.js', () => ({ getAccountUseStore: () => ({ record() {} }) }));
function phaseSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  services.manager.resolveKey.mockClear();
});
it.each([false, true, 'cold-queue'] as const)(
  'adopts Gemini through generic REST, qualified preparation A→B: %s, preserving frozen cold settings and signed history',
  async (variant) => {
    const prepared = variant !== false;
    vi.resetModules();
    const { ownedResponsesRuntimeFixture } =
      await import('./fixtures/owned-local-responses-runtime.js');
    const f = await ownedResponsesRuntimeFixture(cleanups, {
      chatRoute: true,
      gemini: true,
      ordinaryPreparation: prepared,
    });
    services.workspace = f.workspace;
    services.library = f.library;
    services.authId = f.auth.id;
    let preparation: ReturnType<typeof f.workspace.get> | undefined;
    if (prepared) {
      const preview = await f.workspace.preview(
        f.reservation.binding,
        'fixture-github',
        'example/repo',
        f.signal.signal,
        {
          runOn: 'local',
          runtime: { account: f.request.runtime.account, harness: 'gemini', targetId: 'local-mac' },
        },
      );
      const ready = await f.workspace.prepare(preview.id, f.reservation.binding, f.signal.signal);
      preparation = f.workspace.get(ready.id);
      expect(preparation.ordinaryPreparation?.originalBinding.model).toBe('gemini-2.5-pro');
      expect(JSON.stringify(ready)).not.toMatch(/credentialDigest|sourceIdentity|refresh_token/);
      f.reservation.id = ready.id;
      f.reservation.conversationId = (
        await import('../ordinary-repository-startup.js')
      ).nativeStartupSessionId(`repository:${ready.id}`);
      f.reservation.binding = { ...f.reservation.binding, model: 'gemini-2.5-flash' };
      f.request.selection = { ...f.request.selection, model: 'gemini-2.5-flash', thinking: 'high' };
      f.reserved.directory = join(f.reservation.taskRoot, `repo-${ready.id}`, 'mgmt');
    }
    const nativeModel = prepared ? 'gemini-2.5-flash' : 'gemini-2.5-pro';

    vi.spyOn(GoogleAuth.prototype, 'getAccessToken').mockImplementation(async function (
      this: GoogleAuth,
    ) {
      expect(this.jsonContent).toMatchObject({
        type: 'authorized_user',
        client_id: 'offline-client',
      });
      if (!prepared && requests.length === 4) {
        queuedTokenStarted.resolve();
        await queuedTokenGate.promise;
      }
      return 'offline-google-token';
    });
    const chat = await import('../chat.js');
    const responses = await import('../responses-chat-session.js');
    const native = responses.getNativeResponsesStore();
    cleanups.push(() => {
      const live = chat.registry.findBySessionId(f.reservation.conversationId);
      if (live) chat.registry.abort(live.clientId);
      chat.eventStore.close();
      native.close();
    });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const queuedTokenStarted = phaseSignal();
    const queuedTokenGate = phaseSignal();
    const fifthRequest = phaseSignal();
    cleanups.push(() => queuedTokenGate.resolve());
    let hold = false;
    let release: () => void = () => {};
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      expect(String(url)).toBe(
        `https://europe-west1-aiplatform.googleapis.com/v1/projects/original-project/locations/europe-west1/publishers/google/models/${nativeModel}:generateContent`,
      );
      expect(init.headers).toMatchObject({ Authorization: 'Bearer offline-google-token' });
      const body = JSON.parse(String(init.body));
      requests.push({ url: String(url), body });
      if (requests.length === 5) fifthRequest.resolve();
      const receipt = chat.eventStore.getLatestOrdinaryCommandAdmission(
        f.reservation.conversationId,
      );
      expect(receipt?.state).toBe('consumed');
      const result = () =>
        new Response(
          JSON.stringify({
            responseId: `native-${requests.length}`,
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: `answer-${requests.length}`,
                      thoughtSignature: `signature-${requests.length}`,
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
          }),
        );
      if (hold) {
        hold = false;
        return new Promise<Response>((resolve, reject) => {
          release = () => resolve(result());
          init.signal?.addEventListener('abort', () => reject(Error('offline stopped')), {
            once: true,
          });
        });
      }
      return result();
    });
    vi.stubGlobal('fetch', fetch);
    let transportOpen = true;
    const transport = { send: vi.fn(), isOpen: () => transportOpen };
    const router = (
      await import('../ordinary-local-codex-entry.js')
    ).createOwnedLocalCodexEntryRouter(
      { isOpen: () => true, isOwnedBy: () => true } as never,
      {
        sessionRegistry: chat.registry,
        eventStore: chat.eventStore,
        connRegistry: { get: () => ({ transport }), watch: vi.fn(), setActive: vi.fn() } as never,
      },
      true,
    );
    const invoke = (
      url: string,
      body: unknown,
      selectedRouter = router,
      method = 'POST',
      auth = f.auth,
    ) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        let status = 200;
        const req = {
          method,
          url,
          headers: { 'x-connection-id': f.dependencies.operatorConnectionId },
          body,
        };
        const res = {
          locals: { authSession: auth },
          set() {
            return this;
          },
          status(code: number) {
            status = code;
            return this;
          },
          json(value: Record<string, unknown>) {
            resolve({ status, body: value });
            return this;
          },
        };
        (
          selectedRouter as import('express').Router & {
            handle(req: unknown, res: unknown, next: (error?: unknown) => void): void;
          }
        ).handle(req, res, (error) => reject(error ?? Error('Unmatched route')));
      });
    const wire = { ...f.request, runOn: 'local', repositoryWorkspaceId: f.reservation.id };
    expect(wire.runtime.harness).toBe('gemini');
    expect(process.env.MITZO_ORDINARY_LOCAL_GEMINI_ENABLED).toBe('1');
    await expect(invoke('/send', wire)).resolves.toMatchObject({
      status: 202,
      body: { state: 'consumed', dispatched: true },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() =>
      expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
    );
    const original = native.load(f.reservation.conversationId, f.reservation.binding)!;
    if (preparation) {
      const claimed = f.workspace.get(f.reservation.id);
      expect(claimed.ordinaryPreparation).toEqual(preparation.ordinaryPreparation);
      expect(claimed.sourceDigest).toBe(preparation.sourceDigest);
      expect(claimed.featureBranch).toBe(preparation.featureBranch);
      expect(claimed.connectionRevision).toBe(preparation.connectionRevision);
      expect(claimed.binding.model).toBe(nativeModel);
      expect(original.nativeSelection).toEqual({ model: nativeModel, reasoningEffort: 'high' });
      expect(original.checkpoint?.model).toBe(nativeModel);
      expect(chat.eventStore.getSession(f.reservation.conversationId)?.accountBinding?.model).toBe(
        nativeModel,
      );
      await expect(invoke('/send', wire)).resolves.toMatchObject({
        status: 202,
        body: { state: 'consumed' },
      });
      expect(requests).toHaveLength(1);
      await expect(
        invoke('/send', { ...wire, payload: { text: 'Different frozen first message' } }),
      ).resolves.toMatchObject({ status: 409 });
      expect(requests).toHaveLength(1);
    }

    expect(original.checkpoint!.input).toContainEqual({
      role: 'model',
      parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
    });
    const command = (id: string, text: string) => ({
      ...wire,
      sessionId: f.reservation.conversationId,
      clientMsgId: id,
      payload: { text },
    });
    for (const [id, selection] of [
      [
        'different-model',
        {
          ...wire.selection,
          model: prepared ? 'gemini-2.5-pro' : 'gemini-2.5-flash',
          thinking: prepared ? 'low' : 'high',
        },
      ],
      ['different-thinking', { ...wire.selection, thinking: prepared ? 'low' : 'high' }],
    ] as const) {
      const invalid = { ...command(id, 'Changed native choice'), selection };
      await expect(invoke('/continue', invalid)).resolves.toMatchObject({ status: 409 });
      expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(id)).toBeUndefined();
      expect(native.load(f.reservation.conversationId, f.reservation.binding)).toEqual(original);
      expect(invalid.selection).toEqual(selection);
    }
    await expect(invoke('/continue', command('follow', 'Same task'))).resolves.toMatchObject({
      status: 202,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await vi.waitFor(() =>
      expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
    );
    expect(requests[1].body.contents as unknown[]).toContainEqual({
      role: 'model',
      parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
    });
    const cwd = chat.eventStore.getSession(f.reservation.conversationId)!.cwd;
    expect(cwd).toBe(f.reserved.directory);
    expect(cwd).not.toBe(join(f.root, 'source'));
    const firstClient = chat.registry.findBySessionId(f.reservation.conversationId)!.clientId;
    chat.registry.get(firstClient)!.ordinaryRuntimeOwner!.close();
    await vi.waitFor(() =>
      expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
    );
    expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
      true,
    );
    await expect(invoke('/continue', command('cold', 'Retained task'))).resolves.toMatchObject({
      status: 202,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await vi.waitFor(() =>
      expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
    );
    expect(chat.eventStore.getSession(f.reservation.conversationId)!.cwd).toBe(cwd);
    expect(requests[2].body.contents as unknown[]).toContainEqual({
      role: 'model',
      parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
    });
    if (variant === 'cold-queue') {
      await vi.waitFor(() =>
        expect(native.queue(f.reservation.conversationId, f.reservation.binding).active).toBeNull(),
      );
      const { OrdinaryLocalCodexSelectionOwner } =
        await import('../ordinary-local-codex-selection-owner.js');
      const originalCurrent = OrdinaryLocalCodexSelectionOwner.prototype.assertCurrent;
      let validating = false,
        releaseValidation!: () => void,
        expireEntry!: () => void;
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      const selectionProbe = vi
        .spyOn(OrdinaryLocalCodexSelectionOwner.prototype, 'assertCurrent')
        .mockImplementation(async function (
          this: InstanceType<typeof OrdinaryLocalCodexSelectionOwner>,
          expected,
        ) {
          validating = true;
          await validationGate;
          return originalCurrent.call(this, expected);
        });
      // Freeze the request clock while invoking its deadline callback explicitly.
      vi.spyOn(performance, 'now').mockReturnValue(Math.trunc(performance.now()));
      const originalTimer = globalThis.setTimeout;
      const timerProbe = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, ms, ...args) => {
          if (ms === 120000 && typeof handler === 'function') expireEntry = () => handler(...args);
          return originalTimer(handler, ms, ...args);
        });
      const beforeWarm = native.queue(f.reservation.conversationId, f.reservation.binding);
      const existingOwner = chat.registry.findBySessionId(f.reservation.conversationId)!.session
        .ordinaryRuntimeOwner;
      const expiredWarm = invoke('/continue', command('expired-warm', 'Preserve original owner'));
      await vi.waitFor(() => expect(validating).toBe(true));
      expireEntry();
      releaseValidation();
      await expect(expiredWarm).resolves.toMatchObject({ status: 409 });
      expect(
        chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('expired-warm')?.state,
      ).not.toBe('consumed');
      expect(native.queue(f.reservation.conversationId, f.reservation.binding)).toEqual(beforeWarm);
      expect(
        chat.registry.findBySessionId(f.reservation.conversationId)!.session.ordinaryRuntimeOwner,
      ).toBe(existingOwner);
      expect(
        chat.registry.findBySessionId(f.reservation.conversationId)!.session.abortController.signal
          .aborted,
      ).toBe(false);
      selectionProbe.mockRestore();
      timerProbe.mockRestore();
      const queues = await import('../ordinary-local-responses-queue.js');
      hold = true;
      await expect(
        invoke('/continue', command('held-full', 'Hold accepted turn')),
      ).resolves.toMatchObject({ status: 202 });
      await vi.waitFor(() => expect(requests).toHaveLength(4));
      const accepted = Array.from({ length: 32 }, (_, i) =>
        command(`cold-full-${i}`, `Frozen FIFO ${i}`),
      );
      for (const value of accepted)
        await expect(invoke('/continue', value)).resolves.toMatchObject({ status: 202 });
      await expect(invoke('/continue', accepted[31])).resolves.toMatchObject({
        status: 202,
        body: { dispatched: false },
      });
      await expect(invoke('/continue', command('overflow', 'Unadmitted'))).resolves.toMatchObject({
        status: 409,
      });
      expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('overflow')).toBeUndefined();
      const receipts = accepted.map((value) =>
        chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(value.clientMsgId),
      );
      await chat.registry.findBySessionId(f.reservation.conversationId)!.session.queryInstance!
        .interrupt!();
      chat.registry
        .findBySessionId(f.reservation.conversationId)!
        .session.ordinaryRuntimeOwner!.close();
      await vi.waitFor(() =>
        expect(chat.registry.findBySessionId(f.reservation.conversationId)).toBeNull(),
      );
      const ids = accepted.map((value) => value.clientMsgId);
      expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(ids);
      expect(
        queues.readOwnedResponsesQueue(
          chat.eventStore,
          native,
          f.reservation.conversationId,
          f.reservation.binding,
          false,
          chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id),
        ),
      ).toMatchObject({ queued: 32, connected: false, canContinue: true });
      const { ConnectionRegistry } = await import('@mitzo/harness');
      const connections = new ConnectionRegistry();
      connections.register(f.dependencies.operatorConnectionId, transport);
      chat.setConnectionRegistry(connections);
      cleanups.push(() => chat.setConnectionRegistry(new ConnectionRegistry()));
      const resume = () =>
        chat.continueOwnedLocalResponsesQueue(
          f.reservation.conversationId,
          f.auth,
          f.dependencies.operatorConnectionId,
        );
      await expect(
        chat.continueOwnedLocalResponsesQueue(
          f.reservation.conversationId,
          { ...f.auth, id: 'foreign' },
          f.dependencies.operatorConnectionId,
        ),
      ).rejects.toThrow();
      await expect(
        chat.continueOwnedLocalResponsesQueue(f.reservation.conversationId, f.auth),
      ).rejects.toThrow();
      services.authId = 'foreign-sse';
      await expect(resume()).rejects.toThrow();
      services.authId = f.auth.id;
      const signedState = native.load(f.reservation.conversationId, f.reservation.binding)!;
      const changedState = {
        ...signedState,
        checkpoint: { ...signedState.checkpoint!, model: 'gemini-2.5-pro' },
      };
      native.save(f.reservation.conversationId, f.reservation.binding, changedState);
      expect(chat.canResumeOwnedLocalResponsesDriver(f.reservation.conversationId, f.auth.id)).toBe(
        false,
      );
      await expect(resume()).rejects.toThrow();
      expect(native.load(f.reservation.conversationId, f.reservation.binding)).toEqual(
        changedState,
      );
      expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(ids);
      native.save(f.reservation.conversationId, f.reservation.binding, signedState);
      const { OrdinaryLocalResponsesOwnedRuntime } =
        await import('../ordinary-local-responses-owned-runtime.js');
      const actual = OrdinaryLocalResponsesOwnedRuntime.prototype.reopenRetainedQueue;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const pending = vi
        .spyOn(OrdinaryLocalResponsesOwnedRuntime.prototype, 'reopenRetainedQueue')
        .mockImplementation(async function (
          this: InstanceType<typeof OrdinaryLocalResponsesOwnedRuntime>,
        ) {
          await gate;
          return actual.call(this);
        });
      const timeout = globalThis.setTimeout;
      let expire!: () => void;
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((handler, ms, ...args) => {
          if (ms === 120000 && typeof handler === 'function') expire = () => handler(...args);
          return timeout(handler, ms, ...args);
        });
      const interrupted = resume();
      const rejection = expect(interrupted).rejects.toThrow();
      await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
      expire();
      releaseGate();
      await rejection;
      timer.mockRestore();
      pending.mockRestore();
      expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(ids);
      expect(requests).toHaveLength(4);
      let releaseReopen!: () => void;
      const gate2 = new Promise<void>((resolve) => {
        releaseReopen = resolve;
      });
      const reopening = vi
        .spyOn(OrdinaryLocalResponsesOwnedRuntime.prototype, 'reopenRetainedQueue')
        .mockImplementation(async function (
          this: InstanceType<typeof OrdinaryLocalResponsesOwnedRuntime>,
        ) {
          await gate2;
          return actual.call(this);
        });
      const resumed = resume();
      await vi.waitFor(() => expect(reopening).toHaveBeenCalledTimes(1));
      await expect(resume()).rejects.toThrow();
      await expect(
        invoke('/continue', command('racing', 'No fresh admission')),
      ).resolves.toMatchObject({ status: 409 });
      expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('racing')).toBeUndefined();
      expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toEqual(ids);
      transportOpen = false;
      releaseReopen();
      await resumed;
      reopening.mockRestore();
      const reopened = chat.registry.findBySessionId(f.reservation.conversationId)!;
      expect(chat.registry.isAttached(reopened.clientId)).toBe(false);
      transportOpen = true;
      expect(chat.reattachChat(reopened.clientId, transport)).toBe(true);
      await vi.waitFor(() => expect(requests).toHaveLength(36), { timeout: 30000 });
      await vi.waitFor(() =>
        expect(native.queue(f.reservation.conversationId, f.reservation.binding).active).toBeNull(),
      );
      expect(
        accepted.map((value) =>
          chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(value.clientMsgId),
        ),
      ).toEqual(receipts);
      expect(
        native.load(f.reservation.conversationId, f.reservation.binding)?.nativeSelection,
      ).toEqual({ model: nativeModel, reasoningEffort: 'high' });
      expect(requests[35].body.contents).toContainEqual({
        role: 'model',
        parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
      });
      expect(services.manager.resolveKey).not.toHaveBeenCalled();
      return;
    }
    hold = true;
    await expect(invoke('/continue', command('held', 'Hold turn'))).resolves.toMatchObject({
      status: 202,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    await expect(invoke('/continue', command('queued', 'Frozen future'))).resolves.toMatchObject({
      status: 202,
    });
    expect(requests).toHaveLength(4);
    const queues = await import('../ordinary-local-responses-queue.js');
    const queueRouter = (await import('../codex-queue-routes.js')).createCodexQueueRouter({
      binding: () => f.reservation.binding,
      overview: (id, binding) =>
        queues.readOwnedResponsesQueueOverview(chat.eventStore, native, id, binding),
      cancel: (id, binding, commandId, auth) =>
        queues.cancelOwnedResponsesQueuedCommand(
          chat.eventStore,
          native,
          id,
          binding,
          commandId,
          auth,
        ),
      retry: async () => 'unavailable',
      reattach: async () => 'unavailable',
    });
    expect(
      queues.readOwnedResponsesQueue(
        chat.eventStore,
        native,
        f.reservation.conversationId,
        f.reservation.binding,
        true,
      ),
    ).toMatchObject({
      queued: 1,
      model: nativeModel,
      reasoningEffort: prepared ? 'high' : 'low',
      retryable: false,
    });
    await expect(
      invoke(
        `/${f.reservation.conversationId}/codex-queue/queued/cancel`,
        {},
        queueRouter,
        'POST',
        {
          ...f.auth,
          id: randomUUID(),
        },
      ),
    ).resolves.toMatchObject({ status: 409 });
    expect(native.queue(f.reservation.conversationId, f.reservation.binding).queued).toContain(
      'queued',
    );
    release();
    if (!prepared) {
      // Credential/context qualification precedes the provider request. Hold
      // that real phase explicitly; four requests does not mean a lost queue.
      await queuedTokenStarted.promise;
      expect(requests).toHaveLength(4);
      expect(native.queue(f.reservation.conversationId, f.reservation.binding)).toMatchObject({
        active: 'queued',
        queued: [],
      });
      expect(chat.eventStore.getOrdinaryLocalResponsesCommandAdmission('queued')).toMatchObject({
        state: 'consumed',
      });
      queuedTokenGate.resolve();
    }
    // Wait for the fake provider's actual fifth request under the unchanged
    // 60s case budget, then retain the exact count, signed history and idle checks.
    await fifthRequest.promise;
    expect(requests).toHaveLength(5);
    await vi.waitFor(() =>
      expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe('idle'),
    );
    expect(requests[4].body.contents as unknown[]).toContainEqual({
      role: 'model',
      parts: [{ text: 'answer-1', thoughtSignature: 'signature-1' }],
    });
    hold = true;
    await invoke('/continue', command('stopped', 'Stop active turn'));
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    const live = chat.registry.findBySessionId(f.reservation.conversationId)!.session;
    await responses.getResponsesRuntime(live)!.interrupt();
    await vi.waitFor(() =>
      expect(native.status(f.reservation.conversationId, f.reservation.binding)).toBe(
        'interrupted',
      ),
    );
    expect(native.queue(f.reservation.conversationId, f.reservation.binding).paused).toBe(true);
    const before = chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(
      native.queue(f.reservation.conversationId, f.reservation.binding).active!,
    );
    await writeFile(
      join(f.dependencies.privateRoot, 'google-adc.json'),
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'changed',
        client_secret: 'offline',
        refresh_token: 'offline',
      }),
      { mode: 0o600 },
    );
    await expect(
      invoke('/continue', command('authority-lost', 'No new effect')),
    ).resolves.toMatchObject({ status: 409 });
    expect(
      chat.eventStore.getOrdinaryLocalResponsesCommandAdmission(
        native.queue(f.reservation.conversationId, f.reservation.binding).active!,
      ),
    ).toEqual(before);
    expect(requests).toHaveLength(6);
    expect(services.manager.resolveKey).not.toHaveBeenCalled();
  },
  60000,
);
