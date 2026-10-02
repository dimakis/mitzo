import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const accountBinding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex' as const,
  model: 'luna-fixture',
  profileRevision: 'v1',
};
const provenance = {
  version: 2 as const,
  seatLabel: 'Writer',
  seatRole: 'implementer',
  capturedAt: 1,
  accountBinding,
  reasoningEffort: null,
  profileBinding: { profileId: 'profile', profileRevision: 'p1' },
  contextGrant: { grantId: 'context', revision: 1 },
  authorityGrant: { grantId: 'authority', revision: 1 },
  seatId: 'seat',
  membershipGeneration: 1,
  configRevision: 2,
  accountProfileRevision: 'v1',
  seatProfileRevision: 'p1',
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'domain',
  isolationDomainRevision: 1,
};
const input = {
  version: 1 as const,
  claimToken: 'claim',
  sessionId: 'session',
  deliveryId: 'delivery',
  seatId: 'seat',
  attemptId: 1,
  dispatchSeq: 3,
  idempotencyKey: 'key',
  dispatchedContent: 'approved input',
  provenance,
  accountBinding,
};
const identity = {
  claimToken: 'claim',
  sessionId: 'session',
  seatId: 'seat',
  membershipGeneration: 1,
  accountBinding,
  provenance,
  providerThreadId: 'thread',
  providerTurnId: 'turn',
};
const completion = {
  claimToken: 'claim',
  providerThreadId: 'thread',
  providerTurnId: 'turn',
  output: 'exact output',
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'completion-checkpoint-'));
  roots.push(root);
  const path = join(root, 'claims.db');
  const registry = new SymposiumAttemptRegistry(path);
  registry.reserve({
    claimToken: 'claim',
    sessionId: 'session',
    sandbox: { sandboxName: 'sandbox', workdir: '/work' },
  });
  return { registry, path };
}
it('requires matching terminal completion and exact cleanup, then survives restart without dispatch', () => {
  const { registry, path } = fixture();
  registry.checkpoints.capture(input);
  expect(() => registry.checkpoints.complete(completion)).toThrow();
  registry.observations.accept(identity);
  registry.observations.terminal({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'completed',
  });
  expect(() => registry.checkpoints.complete({ ...completion, providerTurnId: 'other' })).toThrow();
  registry.markConfirmed('claim');
  registry.checkpoints.complete(completion);
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.checkpoints.get('claim')?.valid).toBe(true);
  reopened.close();
});
it('is idempotent for exact bytes and rejects conflicting retries and late terminal conflicts', () => {
  const { registry, path } = fixture();
  registry.checkpoints.capture(input);
  registry.observations.accept(identity);
  registry.observations.terminal({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'completed',
  });
  expect(() => registry.checkpoints.complete(completion)).toThrow();
  registry.markConfirmed('claim');
  const checkpoint = registry.checkpoints.complete(completion);
  expect(registry.checkpoints.complete(completion)).toEqual(checkpoint);
  expect(() => registry.checkpoints.capture({ ...input, dispatchedContent: 'changed' })).toThrow();
  expect(() => registry.checkpoints.complete({ ...completion, output: 'changed' })).toThrow();
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.checkpoints.get('claim')).toEqual(checkpoint);
  reopened.observations.conflict({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'failed',
  });
  expect(reopened.checkpoints.get('claim')?.valid).toBe(false);
  expect(() => reopened.checkpoints.complete(completion)).toThrow();
  reopened.close();
});
it.each(['accepted', 'interrupted', 'failed'] as const)(
  'never promotes %s or mismatched provider identity',
  (status) => {
    const { registry } = fixture();
    registry.checkpoints.capture(input);
    registry.observations.accept(identity);
    if (status !== 'accepted')
      registry.observations.terminal({
        claimToken: 'claim',
        providerThreadId: 'thread',
        providerTurnId: 'turn',
        status,
      });
    registry.markConfirmed('claim');
    expect(() => registry.checkpoints.complete(completion)).toThrow();
    expect(registry.checkpoints.get('claim')).toBeUndefined();
    registry.close();
  },
);
it('rejects empty claims and stale provenance without persisting a checkpoint', () => {
  const { registry } = fixture();
  expect(() => registry.checkpoints.capture({ ...input, claimToken: ' ' })).toThrow();
  expect(() =>
    registry.checkpoints.capture({
      ...input,
      accountBinding: { ...accountBinding, model: 'other' },
    }),
  ).toThrow();
  expect(() =>
    registry.checkpoints.capture({
      ...input,
      provenance: { ...provenance, version: undefined },
    } as never),
  ).toThrow();
  registry.checkpoints.capture(input);
  registry.observations.accept({ ...identity, provenance: { ...provenance, configRevision: 9 } });
  registry.observations.terminal({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'completed',
  });
  registry.markConfirmed('claim');
  expect(() => registry.checkpoints.complete(completion)).toThrow();
  expect(registry.checkpoints.get('claim')).toBeUndefined();
  registry.close();
});

it.each(['success', 'cleanup', 'claim'])(
  'wires post-close persistence before native success (%s)',
  async (failure) => {
    const cleanupFails = failure === 'cleanup';
    const { createCodexNativeSeat } = await import('../symposium-codex-native.js');
    const { registry } = fixture();
    const execution = {
      sessionId: 'session',
      deliveryId: 'delivery',
      claimToken: 'claim',
      idempotencyKey: 'key',
      content: input.dispatchedContent,
      provenance,
      signal: new AbortController().signal,
      seat: {
        id: 'seat',
        name: 'Writer',
        role: 'implementer',
        model: accountBinding.model,
        accountBinding,
        systemPrompt: '',
        color: '#123456',
      },
    };
    const record = { ...input, status: 'executing' } as never;
    let options!: import('../codex-conversation.js').CodexConversationOptions;
    const native = await createCodexNativeSeat(
      {
        execution,
        route: { model: accountBinding.model, effort: null, readOnly: false } as never,
        sandbox: { sandboxName: 'sandbox', workdir: '/work' },
        store: {} as never,
        attemptRegistry: registry,
        resolveAttempt: () =>
          failure === 'claim'
            ? ({ ...input, dispatchedContent: 'changed', status: 'executing' } as never)
            : record,
        testConfirmStopped: async () => {
          expect(registry.checkpoints.get('claim')).toBeUndefined();
          if (cleanupFails) throw new Error('cleanup unknown');
          registry.markConfirmed('claim');
        },
        createConversation: (value) => {
          options = value;
          return {
            initialize: async () => {},
            getThreadId: () => 'thread',
            interrupt: async () => {},
            close() {},
            send: async (command) => {
              options.onProviderDispatch?.(command.id);
              options.onProviderAccepted?.(command.id, 'thread', 'turn');
              options.emit({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'exact output' }] },
              } as never);
              options.onProviderTerminal?.(command.id, 'turn', 'completed');
              options.onProviderComplete?.(command.id, 'completed');
            },
          };
        },
      },
      {
        profile: {} as never,
        modelProvider: 'openshell',
        verifyBinding: async () => accountBinding,
        assertCommand() {},
      },
    );
    const result = native.run(execution, { beforeDispatch() {}, accepted() {} });
    if (failure === 'claim') {
      await expect(result).rejects.toThrow('immutable execution claim');
      expect(registry.observations.get('claim')).toBeUndefined();
    } else if (cleanupFails) {
      await expect(result).rejects.toThrow('cleanup unknown');
      expect(registry.checkpoints.get('claim')).toBeUndefined();
    } else {
      await expect(result).resolves.toMatchObject({ content: 'exact output' });
      expect(registry.checkpoints.get('claim')).toMatchObject({
        valid: true,
        output: 'exact output',
      });
      options.onProviderTerminalConflict?.('claim', 'thread', 'turn', 'failed', 'completed');
      expect(registry.checkpoints.get('claim')?.valid).toBe(false);
    }
    registry.close();
  },
);

it('rolls back a failed commit and allows an identical retry after reopening without redispatch', () => {
  const { registry, path } = fixture();
  registry.checkpoints.capture(input);
  registry.observations.accept(identity);
  registry.observations.terminal({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'completed',
  });
  registry.markConfirmed('claim');
  const external = new Database(path);
  external.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON symposium_completion_checkpoints BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END",
  );
  expect(() => registry.checkpoints.complete(completion)).toThrow('disk failure');
  expect(registry.checkpoints.get('claim')).toBeUndefined();
  registry.close();
  external.exec('DROP TRIGGER fail_checkpoint');
  external.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.checkpoints.complete(completion)).toMatchObject({
    valid: true,
    output: 'exact output',
  });
  reopened.close();
});

it('observes invalidation committed through a separate registry connection', () => {
  const { registry, path } = fixture();
  registry.checkpoints.capture(input);
  registry.observations.accept(identity);
  registry.observations.terminal({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'completed',
  });
  registry.markConfirmed('claim');
  registry.checkpoints.complete(completion);
  const other = new SymposiumAttemptRegistry(path);
  other.observations.conflict({
    claimToken: 'claim',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    status: 'interrupted',
  });
  expect(registry.checkpoints.get('claim')?.valid).toBe(false);
  other.close();
  registry.close();
});
