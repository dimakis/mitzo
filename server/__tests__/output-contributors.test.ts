import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { SymposiumOrchestrator } from '../symposium-orchestrator.js';
import {
  createOutputContributors,
  OutputContributorAddInputSchema,
} from '../output-contributors.js';
import { outputContextPackageDigest } from '../session-output-routes.js';
import type { OrdinaryChatPort } from '../symposium-ordinary-turn.js';

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  cleanup.splice(0).forEach((f) => f());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'output-contributors-'));
  dirs.push(root);
  const databasePath = join(root, 'events.db');
  const store = new EventStore(databasePath);
  cleanup.push(() => store.close());
  store.upsertSession({ sessionId: 'source', conversationSource: 'mitzo', cwd: root });
  store.append('source', 'message_start', { messageId: 'draft' });
  store.append('source', 'block_start', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'block_delta', {
    messageId: 'draft',
    blockId: 'text',
    delta: 'Selected draft',
  });
  store.append('source', 'block_end', { messageId: 'draft', blockId: 'text', blockType: 'text' });
  store.append('source', 'message_end', { messageId: 'draft' });
  const candidate = store.listSessionOutputCandidates('source')[0];
  const output = store.registerSessionOutput('source', {
    requestId: 'keep',
    title: 'Draft',
    source: candidate.source,
  });
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: join(root, 'account'),
        email: 'offline@example.invalid',
        planType: 'plus',
        models: [{ id: 'offline-model', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  let turn = 0;
  const port: OrdinaryChatPort = {
    startChat: vi.fn(async (transport, _client, _prompt, options) => {
      const id = options.resume ?? options.initialSessionId!;
      store.upsertSession({
        sessionId: id,
        conversationSource: 'mitzo',
        cwd: root,
        accountBinding: profiles.resolve('personal', 'offline-model'),
      });
      store.append(id, 'contributor_execution', {
        ...options.contributorExecution,
        childSessionId: id,
      });
      options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
      options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'raw-thread', `turn-${++turn}`);
      const startEvent = {
        type: 'block_start',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
      } as const;
      transport.send(startEvent);
      options.onQueryEvent?.({ ...startEvent, sessionId: id });
      const deltaEvent = {
        type: 'block_delta',
        messageId: 'reply',
        blockId: 'text',
        blockType: 'text',
        delta: 'Contributor reply',
      } as const;
      transport.send(deltaEvent);
      options.onQueryEvent?.({ ...deltaEvent, sessionId: id });
      options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, `turn-${turn}`, 'completed');
      options.onTurnResult?.({});
    }),
    stopChat: vi.fn(),
  };
  const deps = {
    store,
    databasePath,
    currentAccounts: () => profiles,
    port,
    workspaceForSession: (id: string) => (id === 'source' ? { cwd: root } : null),
    resolveProfile: vi.fn(async () => null),
    readMessages: vi.fn(async () => []),
  };
  const service = createOutputContributors(deps);
  cleanup.unshift(() => service.close());
  const input = {
    requestId: 'add',
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: outputContextPackageDigest('source', output),
    accountId: 'personal',
    model: 'offline-model',
    label: 'Contributor',
    instructions: 'Help improve the selected draft.',
    mode: 'ask' as const,
  };
  return { service, store, deps, input, port, output };
}
describe('ordinary contributors to registered outputs', () => {
  it.each([
    { lateAcceptance: false, retained: 'current' },
    { lateAcceptance: true, retained: 'current' },
    { lateAcceptance: true, retained: 'controller-loss' },
    { lateAcceptance: false, retained: 'unbound' },
    { lateAcceptance: false, retained: 'ambiguous' },
    { lateAcceptance: false, retained: 'conflicting' },
    { lateAcceptance: false, retained: 'missing-claim' },
    { lateAcceptance: false, retained: 'missing-owner' },
    { lateAcceptance: false, retained: 'wrong-account' },
    { lateAcceptance: false, retained: 'partial-recovery' },
  ])(
    'preserves confirmed Stop child continuity with $retained history (late acceptance $lateAcceptance)',
    async ({ lateAcceptance, retained }) => {
      const { service, deps, input, port, store } = setup();
      let acceptedChild = '';
      let acceptanceError: unknown;
      vi.mocked(port.startChat).mockImplementationOnce(
        async (_transport, _client, _prompt, options) => {
          acceptedChild = options.initialSessionId!;
          store.upsertSession({
            sessionId: acceptedChild,
            conversationSource: 'mitzo',
            accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
          });
          store.append(acceptedChild, 'contributor_execution', {
            ...options.contributorExecution,
            childSessionId: acceptedChild,
          });
          options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
          const accept = () =>
            options.ordinaryTurnLifecycle!.accepted(
              options.clientMsgId!,
              'raw-thread',
              'stopped-turn',
            );
          if (!lateAcceptance) accept();
          await new Promise<void>((resolve) => {
            options.onQueryReady?.({
              interrupt: async () => {
                try {
                  if (retained === 'controller-loss') {
                    const raw = store.getSession(contributor.id)?.symposiumConfig;
                    if (!raw) throw Error('Expected contributor configuration');
                    const config = SymposiumConfigSchema.parse(JSON.parse(raw));
                    store.suspendSymposiumForControllerLoss(
                      contributor.id,
                      config.revision,
                      'offline-controller',
                      Date.now(),
                    );
                  }
                  if (lateAcceptance) accept();
                  options.ordinaryTurnLifecycle!.terminal(
                    options.clientMsgId!,
                    'stopped-turn',
                    'interrupted',
                  );
                  options.onTurnResult?.({});
                  resolve();
                } catch (error) {
                  acceptanceError = error;
                  resolve();
                  throw error;
                }
              },
            });
          });
        },
      );
      const contributor = await service.add('source', input);
      const first = service.message('source', contributor.id, {
        requestId: 'first-stopped',
        text: 'Continue',
      });
      await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledOnce());
      if (lateAcceptance) vi.useFakeTimers();
      const stopping = service.stop('source', contributor.id, { requestId: 'stop-first' });
      if (lateAcceptance) await vi.advanceTimersByTimeAsync(30_001);
      const stopped = await stopping;
      vi.useRealTimers();
      expect(acceptanceError).toBeUndefined();
      expect(stopped.status).toBe('idle');
      expect((await first).delivery.status).toBe('cancelled');
      if (retained === 'controller-loss') {
        expect(store.getLatestSymposiumMembership(contributor.id, 'contributor')?.state).toBe(
          'suspended',
        );
        expect(
          store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor'),
        ).toHaveLength(0);
        const attempt = store.getSymposiumRecipientAttempts(
          store.getSymposiumDeliveries(contributor.id)[0].deliveryId,
        )[0];
        expect(attempt.providerThreadId).toBe(acceptedChild);
        expect(attempt.providerTurnId).toBe('stopped-turn');
        expect(attempt.acceptedAt).not.toBeNull();
        expect(
          store.getSymposiumSeatThreads(contributor.id).map((binding) => binding.providerThreadId),
        ).toEqual([acceptedChild]);
        if (
          !attempt.provenance ||
          !('version' in attempt.provenance) ||
          attempt.provenance.version !== 2
        )
          throw Error('Expected immutable ordinary provenance');
        const threadBinding = store.getSymposiumSeatThreads(contributor.id)[0];
        expect(JSON.parse(threadBinding.bindingKey).at(-1)).toBe(
          attempt.provenance.membershipGeneration,
        );
        expect(store.getLatestSymposiumMembership(contributor.id, 'contributor')?.generation).toBe(
          attempt.provenance.membershipGeneration + 1,
        );

        return;
      }

      expect(
        (await service.stop('source', contributor.id, { requestId: 'stop-first' })).status,
      ).toBe('idle');
      const cancelled = store.getSymposiumDeliveries(contributor.id)[0];
      const accepted = store.getSymposiumRecipientAttempts(cancelled.deliveryId)[0];
      if (!accepted.claimToken) throw Error('Expected exact accepted attempt');
      expect(
        store.markSymposiumRecipientAccepted({
          deliveryId: cancelled.deliveryId,
          seatId: 'contributor',
          claimToken: accepted.claimToken,
          providerThreadId: acceptedChild,
          providerTurnId: 'stopped-turn',
          acceptedAt: Date.now() + 1,
          retainSeatThread: true,
        }),
      ).toBe(true);
      expect(store.getSymposiumRecipientAttempts(cancelled.deliveryId)[0]).toEqual(accepted);
      if (retained !== 'current') {
        const db = new Database(deps.databasePath);
        db.prepare('DELETE FROM symposium_seat_threads WHERE session_id=?').run(contributor.id);
        if (retained === 'ambiguous')
          db.prepare('UPDATE symposium_recipient_attempts SET symposium_provenance=NULL').run();
        if (retained === 'missing-claim')
          db.prepare('UPDATE symposium_recipient_attempts SET claim_token=NULL').run();
        if (retained === 'missing-owner')
          db.prepare("DELETE FROM events WHERE type='contributor_execution'").run();
        if (retained === 'wrong-account')
          db.prepare(
            "UPDATE sessions SET account_binding=json_set(account_binding,'$.profileRevision','other') WHERE session_id=?",
          ).run(acceptedChild);
        if (retained === 'partial-recovery')
          db.prepare(
            `INSERT INTO symposium_recipient_attempts
            (delivery_id,seat_id,attempt_number,idempotency_key,claim_token,symposium_provenance,status,
             provider_thread_id,provider_turn_id,accepted_at,dispatched_content,dispatch_seq,
             started_at,updated_at,cleanup_confirmed)
            SELECT delivery_id,seat_id,attempt_number+1,idempotency_key,'unknown-claim',symposium_provenance,status,
             'unowned-child','unowned-turn',accepted_at,dispatched_content,dispatch_seq,
             started_at,updated_at,cleanup_confirmed FROM symposium_recipient_attempts LIMIT 1`,
          ).run();
        if (retained === 'conflicting') {
          const provenance = store.getSymposiumRecipientAttempts(
            store.getSymposiumDeliveries(contributor.id)[0].deliveryId,
          )[0].provenance;
          if (!provenance || !('version' in provenance))
            throw Error('Expected exact retained provenance');
          const bindingKey = JSON.stringify([
            provenance.accountBinding.provider,
            provenance.accountBinding.accountId,
            provenance.accountBinding.model,
            provenance.accountBinding.profileRevision,
            provenance.reasoningEffort,
            provenance.profileBinding.profileId,
            provenance.profileBinding.profileRevision,
            provenance.contextGrant.grantId,
            provenance.contextGrant.revision,
            provenance.authorityGrant.grantId,
            provenance.authorityGrant.revision,
            provenance.isolationDomainId,
            provenance.isolationDomainRevision,
            provenance.membershipGeneration,
          ]);
          db.prepare('INSERT INTO symposium_seat_threads VALUES (?,?,?,?,?,?,?)').run(
            contributor.id,
            'contributor',
            bindingKey,
            'conflicting-child',
            provenance.configRevision,
            1,
            1,
          );
        }
        db.close();
      }
      service.close();
      store.close();
      const reopenedStore = new EventStore(deps.databasePath);
      cleanup.push(() => reopenedStore.close());
      const reopened = createOutputContributors({ ...deps, store: reopenedStore });
      cleanup.unshift(() => reopened.close());
      if (retained !== 'partial-recovery')
        expect((await reopened.list('source')).contributors[0].sessionId).toBe(acceptedChild);
      const previousThreads = reopenedStore.getSymposiumSeatThreads(contributor.id);
      let followupTurn = 0;
      vi.mocked(port.startChat).mockImplementation(
        async (_transport, _client, _prompt, options) => {
          const id = options.resume ?? options.initialSessionId!;
          reopenedStore.upsertSession({
            sessionId: id,
            conversationSource: 'mitzo',
            accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
          });
          reopenedStore.append(id, 'contributor_execution', {
            ...options.contributorExecution,
            childSessionId: id,
          });
          options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
          const turnId = `followup-${++followupTurn}`;
          options.ordinaryTurnLifecycle!.accepted(options.clientMsgId!, 'raw-thread', turnId);
          options.ordinaryTurnLifecycle!.terminal(options.clientMsgId!, turnId, 'completed');
          options.onTurnResult?.({});
        },
      );
      const followup = reopened.message('source', contributor.id, {
        requestId: 'after-stop',
        text: 'Keep going',
      });
      if (
        [
          'ambiguous',
          'conflicting',
          'missing-claim',
          'missing-owner',
          'wrong-account',
          'partial-recovery',
        ].includes(retained)
      ) {
        await expect(followup).rejects.toThrow(/recovery|thread.*changed/);
        expect(port.startChat).toHaveBeenCalledOnce();
        expect(reopenedStore.getSymposiumSeatThreads(contributor.id)).toEqual(previousThreads);
        expect(
          reopenedStore.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor'),
        ).toHaveLength(0);
        const db = new Database(deps.databasePath);
        expect(
          db
            .prepare(
              'SELECT count(*) AS count FROM symposium_seat_execution_claims WHERE session_id=?',
            )
            .get(contributor.id),
        ).toEqual({ count: 0 });
        db.close();
        return;
      }
      expect((await followup).delivery.status).toBe('delivered');
      expect(vi.mocked(port.startChat).mock.calls[1][3].resume).toBe(acceptedChild);
      expect(vi.mocked(port.startChat).mock.calls[1][3].initialSessionId).toBeUndefined();
      await reopened.message('source', contributor.id, {
        requestId: 'after-followup',
        text: 'One more',
      });
      expect(vi.mocked(port.startChat).mock.calls[2][3].resume).toBe(acceptedChild);
    },
  );
  it.each([
    { version: 1 as const, source: 'contexgin' as const, agentName: 'writer' },
    {
      version: 1 as const,
      source: 'workspace' as const,
      files: ['AGENTS.md'],
      tokenBudget: 512,
      required: [['Scope']],
      excluded: [],
    },
  ])(
    'rejects saved $source context recipes before allocation or provider startup',
    async (contextRecipe) => {
      const { service, deps, store, input, port } = setup();
      const definition = {
        name: 'Compiled writer',
        role: 'coder' as const,
        instructions: 'Use the selected material.',
        expectedOutput: 'Draft',
        acceptanceCriteria: ['Use the required context'],
        modelPolicyRole: 'coder',
        contextRecipe,
      };
      const profile = {
        profileId: 'compiled-writer',
        revision: 1,
        definition,
        contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
      };
      Object.assign(deps, { resolveProfile: vi.fn(async () => profile) });
      const allocate = vi.spyOn(store, 'createSymposiumSession');
      await expect(
        service.add(
          'source',
          {
            ...input,
            profileSelection: { profileId: profile.profileId, revision: profile.revision },
          },
          'verified-transport',
        ),
      ).rejects.toThrow('context recipes');
      expect(allocate).not.toHaveBeenCalled();
      expect(store.getOutputContributorBindings('source')).toEqual([]);
      expect(port.startChat).not.toHaveBeenCalled();
    },
  );

  it('rejects recipe-bearing saved profiles during recovery of a previously allocated draft', async () => {
    const { service, deps, store, input, port } = setup();
    const definition = {
      name: 'Compiled writer',
      role: 'coder' as const,
      instructions: 'Use the selected material.',
      expectedOutput: 'Draft',
      acceptanceCriteria: ['Use required context'],
      modelPolicyRole: 'coder',
      contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'writer' },
    };
    const profile = {
      profileId: 'compiled-writer',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    Object.assign(deps, { resolveProfile: vi.fn(async () => profile) });
    const selected = OutputContributorAddInputSchema.parse({
      ...input,
      profileSelection: { profileId: profile.profileId, revision: profile.revision },
    });
    const { requestId, ...selection } = selected;
    store.createSymposiumSession({
      idempotencyKey: `output-contributor:source:${requestId}`,
      fingerprint: createHash('sha256').update(JSON.stringify(selection)).digest('hex'),
      sessionId: 'previously-allocated-draft',
      summary: 'Draft interrupted before activation',
      binding: deps.currentAccounts().resolve(input.accountId, input.model),
      config: {
        version: 2,
        revision: 1,
        state: 'draft',
        anchorSeatId: 'contributor',
        activeSeatCap: 1,
        seats: [
          {
            id: 'contributor',
            name: definition.name,
            role: 'coder',
            model: input.model,
            accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
            systemPrompt: definition.instructions,
            color: '#335577',
          },
        ],
        turnRules: { mode: 'directed', maxTurns: 64 },
        interceptMode: 'manual',
      },
      profileSelections: { contributor: selected.profileSelection! },
      outputBinding: {
        parentSessionId: 'source',
        outputId: input.outputId,
        outputRevision: 1,
        contextPackageDigest: input.contextPackageDigest,
        mode: input.mode,
        label: input.label,
        additionalInstructions: input.instructions,
      },
    });
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    await expect(reopened.add('source', selected, 'verified-transport')).rejects.toThrow(
      'context recipes',
    );
    expect(store.getOutputContributorBindings('source')).toHaveLength(1);
    expect(JSON.parse(store.getSession('previously-allocated-draft')!.symposiumConfig!).state).toBe(
      'draft',
    );
    expect(
      store.getLatestSymposiumMembership('previously-allocated-draft', 'contributor'),
    ).toBeUndefined();
    expect(port.startChat).not.toHaveBeenCalled();
  });
  it('retains accepted child identity only for a current claim and matching ordinary ownership/account', async () => {
    const { service, input, port, store, deps } = setup();
    const normalStart = vi.mocked(port.startChat).getMockImplementation()!;
    vi.mocked(port.startChat).mockImplementation(async (...args) => {
      const options = args[3];
      const execution = options.contributorExecution!;
      const receipt = {
        deliveryId: execution.deliveryId,
        seatId: execution.seatId,
        claimToken: execution.claimToken,
        providerThreadId: 'unrelated-child',
        providerTurnId: 'probe-turn',
        acceptedAt: Date.now(),
        retainSeatThread: true,
      };
      const accountBinding = deps.currentAccounts().resolve(input.accountId, input.model);
      store.upsertSession({
        sessionId: 'unrelated-child',
        conversationSource: 'mitzo',
        accountBinding,
      });
      expect(store.markSymposiumRecipientAccepted({ ...receipt, claimToken: 'stale-claim' })).toBe(
        false,
      );
      expect(() => store.markSymposiumRecipientAccepted(receipt)).toThrow(
        'ordinary contributor ownership',
      );
      store.upsertSession({
        sessionId: 'wrong-account',
        conversationSource: 'mitzo',
        accountBinding: { ...accountBinding, profileRevision: 'other-revision' },
      });
      store.append('wrong-account', 'contributor_execution', {
        ...execution,
        childSessionId: 'wrong-account',
      });
      expect(() =>
        store.markSymposiumRecipientAccepted({ ...receipt, providerThreadId: 'wrong-account' }),
      ).toThrow('ordinary contributor ownership');
      expect(
        store.getSymposiumRecipientAttemptByClaimToken(execution.claimToken)?.acceptedAt,
      ).toBeNull();
      const db = new Database(deps.databasePath, { readonly: true });
      expect(db.prepare('SELECT COUNT(*) AS count FROM symposium_seat_threads').get()).toEqual({
        count: 0,
      });
      db.close();
      await normalStart(...args);
    });
    const contributor = await service.add('source', input);
    const completed = await service.message('source', contributor.id, {
      requestId: 'valid-owned-turn',
      text: 'Continue',
    });
    expect(completed.delivery.status).toBe('delivered');
    expect(completed.contributor.sessionId).not.toBe('unrelated-child');
    expect(completed.contributor.sessionId).not.toBe('wrong-account');
  });
  it.each(['before Stop', 'after Stop'] as const)(
    'retains the exact child accepted %s and reports idle only after terminal and query closure',
    async (acceptanceTiming) => {
      const { service, input, port, store, deps } = setup();
      const interrupted = vi.fn();
      let closeQuery!: () => void;
      let acknowledgeTurn!: () => void;
      let finishTurn!: () => void;
      vi.mocked(port.startChat).mockImplementation(
        async (_transport, _clientId, _prompt, options) => {
          const id = options.initialSessionId!;
          store.upsertSession({
            sessionId: id,
            conversationSource: 'mitzo',
            accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
          });
          store.append(id, 'contributor_execution', {
            ...options.contributorExecution,
            childSessionId: id,
          });
          await new Promise<void>((resolve) => {
            closeQuery = resolve;
            options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
            acknowledgeTurn = () =>
              options.ordinaryTurnLifecycle!.accepted(
                options.clientMsgId!,
                'raw-thread',
                'live-turn',
              );
            finishTurn = () => {
              options.ordinaryTurnLifecycle!.terminal(
                options.clientMsgId!,
                'live-turn',
                'interrupted',
              );
              options.onTurnResult?.({});
            };
            if (acceptanceTiming === 'before Stop') acknowledgeTurn();
            options.onQueryReady?.({
              interrupt: async () => {
                interrupted();
                if (acceptanceTiming === 'before Stop') {
                  finishTurn();
                  resolve();
                }
              },
            });
          });
        },
      );
      const contributor = await service.add('source', input);
      const completion = service.message('source', contributor.id, {
        requestId: 'live-request',
        text: 'Continue',
      });
      await vi.waitFor(() =>
        expect(
          store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor'),
        ).toHaveLength(1),
      );
      await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledTimes(1));
      const stopping = service.stop('source', contributor.id, { requestId: 'stop-exact-turn' });
      if (acceptanceTiming === 'after Stop') {
        await vi.waitFor(() => expect(interrupted).toHaveBeenCalledTimes(1));
        expect(store.getSymposiumDeliveries(contributor.id)[0].status).toBe('cancelled');
        expect(acknowledgeTurn).not.toThrow();
        finishTurn();
        await vi.waitFor(() =>
          expect(
            store.getSymposiumRecipientAttempts(
              store.getSymposiumDeliveries(contributor.id)[0].deliveryId,
            )[0].acceptedAt,
          ).not.toBeNull(),
        );
        expect(
          store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor'),
        ).toHaveLength(1);
        expect((await service.list('source')).contributors[0].status).toBe('stopping');
        closeQuery();
      }
      const stopped = await stopping;
      expect(interrupted).toHaveBeenCalledTimes(1);
      expect(stopped.status).toBe('idle');
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
        0,
      );
      expect((await completion).delivery.status).toBe('cancelled');
      expect(stopped.sessionId).toBeTruthy();
      const retainedChild = stopped.sessionId!;
      service.close();
      store.close();
      const reopenedStore = new EventStore(deps.databasePath);
      cleanup.push(() => reopenedStore.close());
      const reloaded = createOutputContributors({ ...deps, store: reopenedStore });
      cleanup.unshift(() => reloaded.close());
      vi.mocked(port.startChat).mockImplementation(
        async (_transport, _client, _prompt, options) => {
          const child = options.resume ?? options.initialSessionId!;
          reopenedStore.upsertSession({
            sessionId: child,
            conversationSource: 'mitzo',
            accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
          });
          reopenedStore.append(child, 'contributor_execution', {
            ...options.contributorExecution,
            childSessionId: child,
          });
          options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
          options.ordinaryTurnLifecycle!.accepted(
            options.clientMsgId!,
            'raw-thread',
            'followup-turn',
          );
          options.ordinaryTurnLifecycle!.terminal(
            options.clientMsgId!,
            'followup-turn',
            'completed',
          );
          options.onTurnResult?.({});
        },
      );
      expect((await reloaded.list('source')).contributors[0].sessionId).toBe(retainedChild);
      expect(
        (
          await reloaded.message('source', contributor.id, {
            requestId: 'after-stop',
            text: 'Continue the same conversation',
          })
        ).delivery.status,
      ).toBe('delivered');
      expect(vi.mocked(port.startChat).mock.calls[1][3].resume).toBe(retainedChild);
      expect(vi.mocked(port.startChat).mock.calls[1][3].initialSessionId).toBeUndefined();
    },
  );
  it('fences unknown retained execution on reload and rechecks cancelled unsettled cleanup on repeated Stop', async () => {
    const { service, deps, input, port, store } = setup();
    let acceptLate!: () => void;
    let lateReceipt!: Parameters<EventStore['markSymposiumRecipientAccepted']>[0];
    vi.mocked(port.startChat).mockImplementation(
      async (_transport, _clientId, _prompt, options) => {
        const id = options.initialSessionId!;
        store.upsertSession({
          sessionId: id,
          conversationSource: 'mitzo',
          accountBinding: deps.currentAccounts().resolve(input.accountId, input.model),
        });
        store.append(id, 'contributor_execution', {
          ...options.contributorExecution,
          childSessionId: id,
        });
        options.ordinaryTurnLifecycle!.beforeDispatch(options.clientMsgId!);
        lateReceipt = {
          ...options.contributorExecution!,
          providerThreadId: id,
          providerTurnId: 'retained-turn',
          acceptedAt: Date.now(),
          retainSeatThread: true,
        };
        acceptLate = () =>
          options.ordinaryTurnLifecycle!.accepted(
            options.clientMsgId!,
            'raw-thread',
            'retained-turn',
          );
        await new Promise<void>(() => {});
      },
    );
    const contributor = await service.add('source', input);
    void service
      .message('source', contributor.id, { requestId: 'unfinished-turn', text: 'Continue' })
      .catch(() => {});
    await vi.waitFor(() =>
      expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
        1,
      ),
    );
    await vi.waitFor(() => expect(port.startChat).toHaveBeenCalledTimes(1));
    await expect(
      service.message('source', contributor.id, {
        requestId: 'competing-turn',
        text: 'Another request',
      }),
    ).rejects.toThrow('active');
    expect(store.getSymposiumDeliveries(contributor.id)).toHaveLength(1);
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const stopped = await reopened.stop('source', contributor.id, { requestId: 'stop-one' });
    expect(stopped.status).toBe('stopping');
    expect(
      store.markSymposiumRecipientAccepted({ ...lateReceipt, claimToken: 'stale-claim' }),
    ).toBe(false);
    expect(() =>
      store.markSymposiumRecipientAccepted({ ...lateReceipt, providerThreadId: 'source' }),
    ).toThrow('ordinary contributor ownership');
    expect(acceptLate).not.toThrow();
    expect((await reopened.list('source')).contributors[0].sessionId).toBeTruthy();
    expect(store.getUnsettledSymposiumSeatExecutions(contributor.id, 'contributor')).toHaveLength(
      1,
    );
    const reconcile = vi.spyOn(SymposiumOrchestrator.prototype, 'reconcileDeliveryCleanup');
    expect(
      (await reopened.stop('source', contributor.id, { requestId: 'stop-again' })).status,
    ).toBe('stopping');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(port.startChat).toHaveBeenCalledTimes(1);
    await expect(
      reopened.message('source', contributor.id, {
        requestId: 'after-unknown-stop',
        text: 'Continue',
      }),
    ).rejects.toThrow('active');
    await expect(
      reopened.message('other', contributor.id, { requestId: 'wrong-owner', text: 'Write' }),
    ).rejects.toThrow('not found');
  });
  it('recovers an allocation interrupted after membership but before exact admission', async () => {
    const { service, deps, store, input, port } = setup();
    vi.spyOn(store, 'recordSymposiumAdmission').mockImplementationOnce(() => {
      throw new Error('Simulated admission interruption');
    });
    await expect(service.add('source', input)).rejects.toThrow('interruption');
    const id = store.getOutputContributorBindings('source')[0].coordinatorSessionId;
    expect(store.getLatestSymposiumMembership(id, 'contributor')?.reconciliation).not.toBe(
      'confirmed',
    );
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const recovered = await reopened.add('source', input);
    expect(recovered.id).toBe(id);
    expect(store.getLatestSymposiumMembership(id, 'contributor')?.reconciliation).toBe('confirmed');
    expect(port.startChat).not.toHaveBeenCalled();
  });

  it('recovers saved-profile draft activation with exact lookup while preserving separate label and additional user guidance', async () => {
    const { service, deps, store, input, port } = setup();
    const definition = {
      name: 'Saved writer',
      role: 'coder' as const,
      instructions: 'Use the selected material.',
      expectedOutput: 'Draft',
      acceptanceCriteria: ['Be precise'],
      modelPolicyRole: 'coder',
    };
    const profile = {
      profileId: 'writer',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    Object.assign(deps, { resolveProfile: vi.fn(async () => profile) });
    const selected = {
      ...input,
      instructions: 'Respond briefly.',
      profileSelection: { profileId: 'writer', revision: 1 },
    };
    const commit = store.setSymposiumConfig.bind(store);
    vi.spyOn(store, 'setSymposiumConfig')
      .mockImplementationOnce(commit)
      .mockImplementationOnce(() => {
        throw new Error('Simulated draft activation interruption');
      });
    await expect(service.add('source', selected, 'authenticated-transport')).rejects.toThrow(
      'interruption',
    );
    const id = store.getOutputContributorBindings('source')[0].coordinatorSessionId;
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    const recovered = await reopened.add('source', selected, 'authenticated-transport');
    expect(recovered).toMatchObject({ id, label: input.label });
    expect(deps.resolveProfile).toHaveBeenLastCalledWith(
      selected.profileSelection,
      'authenticated-transport',
    );
    await reopened.message('source', id, { requestId: 'profile-turn', text: 'Write' });
    const guidance = vi.mocked(port.startChat).mock.calls[0][3].contributorGuidance;
    expect(guidance).toContain(definition.instructions);
    expect(guidance).toContain('Additional user guidance');
    expect(guidance).toContain('Respond briefly.');
  });

  it('fences source loss and workspace loss, and checks uniqueness outside the bounded list projection', async () => {
    const { service, deps, store, input, port } = setup();
    const contributor = await service.add('source', input);
    const db = new Database(deps.databasePath);
    for (let i = 0; i < 101; i++)
      store.append('source', 'output_contributor_created', {
        ...store.getOutputContributorBindings('source')[0],
        coordinatorSessionId: `irrelevant-${i}`,
        outputId: '00000000-0000-4000-8000-000000000000',
      });
    expect(
      store
        .getOutputContributorBindings('source')
        .some((value) => value.coordinatorSessionId === contributor.id),
    ).toBe(false);
    await expect(service.add('source', { ...input, requestId: 'another' })).rejects.toThrow(
      'already has',
    );
    Object.assign(deps, { workspaceForSession: () => null });
    await expect(
      service.message('source', contributor.id, { requestId: 'lost-workspace', text: 'Write' }),
    ).rejects.toThrow('workspace');
    Object.assign(deps, { workspaceForSession: () => ({ cwd: 'existing' }) });
    db.prepare("DELETE FROM events WHERE type='block_delta'").run();
    await expect(
      service.message('source', contributor.id, { requestId: 'lost-source', text: 'Write' }),
    ).rejects.toThrow('unavailable');
    expect(port.startChat).not.toHaveBeenCalled();
    db.close();
  });
  it('allocates an independent coordinator idempotently without starting providers or changing the source session', async () => {
    const { service, store, deps, input, port } = setup();
    const first = await service.add('source', input);
    expect(first).toMatchObject({
      label: 'Contributor',
      outputId: input.outputId,
      status: 'idle',
      sessionId: null,
    });
    expect((await service.add('source', input)).id).toBe(first.id);
    expect(port.startChat).not.toHaveBeenCalled();
    expect(store.getSession('source')?.symposiumConfig).toBeNull();
    expect(store.getSession(first.id)?.sessionType).toBe('symposium');
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    expect((await reopened.list('source')).contributors.map((c) => c.id)).toEqual([first.id]);
    expect((await reopened.add('source', input)).id).toBe(first.id);
    await expect(reopened.add('source', { ...input, label: 'Changed' })).rejects.toThrow();
  });
  it('dispatches only selected source, preserves child followup and durable attributed replies across reload', async () => {
    const { service, deps, input, port } = setup();
    const contributor = await service.add('source', input);
    const first = await service.message('source', contributor.id, {
      requestId: 'turn-one',
      text: 'Improve this',
    });
    expect(first.delivery.status).toBe('delivered');
    expect(first.contributor.messages[0]).toMatchObject({
      role: 'assistant',
      symposiumProvenance: { accountBinding: { accountId: 'personal', model: 'offline-model' } },
    });
    const calls = vi.mocked(port.startChat).mock.calls;
    expect(calls[0][2]).toContain('Selected draft');
    expect(calls[0][2]).not.toContain('source session history');
    expect(calls[0][3].mode).toBe('ask');
    const child = first.contributor.sessionId;
    expect(child).not.toBe('source');
    await service.message('source', contributor.id, { requestId: 'turn-two', text: 'Continue' });
    expect(calls[1][3].resume).toBe(child);
    await service.message('source', contributor.id, {
      requestId: 'turn-one',
      text: 'Improve this',
    });
    expect(port.startChat).toHaveBeenCalledTimes(2);
    service.close();
    const reopened = createOutputContributors(deps);
    cleanup.unshift(() => reopened.close());
    expect((await reopened.list('source')).contributors[0].messages).toHaveLength(2);
  });
  it('rejects wrong output scope/digest and unresolved saved profiles before allocating authority', async () => {
    const { service, input, store, deps } = setup();
    await expect(
      service.add('source', { ...input, contextPackageDigest: '0'.repeat(64) }),
    ).rejects.toThrow();
    await expect(
      service.add('source', { ...input, profileSelection: { profileId: 'missing', revision: 1 } }),
    ).rejects.toThrow();
    expect(deps.resolveProfile).toHaveBeenCalled();
    expect(store.getOutputContributorBindings('source')).toEqual([]);
    await expect(service.add('unknown', input)).rejects.toThrow();
    store.upsertSession({ sessionId: 'other', conversationSource: 'mitzo' });
    await expect(service.add('other', input)).rejects.toThrow();
  });
});
