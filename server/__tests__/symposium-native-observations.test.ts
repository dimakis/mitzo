import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const binding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex' as const,
  model: 'luna-fixture',
  profileRevision: 'account-v1',
};
const identity = {
  claimToken: 'claim',
  sessionId: 'session',
  seatId: 'writer',
  membershipGeneration: 2,
  accountBinding: binding,
  provenance: {
    seatId: 'writer',
    membershipGeneration: 2,
    configRevision: 1,
    accountProfileRevision: 'account-v1',
    seatProfileRevision: 'profile-v1',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'domain',
    isolationDomainRevision: 1,
  },
  providerThreadId: 'thread',
  providerTurnId: 'turn',
};
const terminal = {
  claimToken: 'claim',
  providerThreadId: 'thread',
  providerTurnId: 'turn',
  status: 'completed' as const,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-observation-'));
  roots.push(root);
  const path = join(root, 'claims.db');
  const registry = new SymposiumAttemptRegistry(path);
  registry.reserve({
    claimToken: 'claim',
    sessionId: 'session',
    sandbox: { sandboxName: 'sandbox', workdir: '/work' },
  });
  return { path, registry };
}
it('persists immutable acceptance and terminal facts when reopening the same registry', () => {
  const { path, registry } = fixture();
  registry.observations.accept(identity);
  registry.observations.accept(identity);
  expect(registry.observations.get('claim')).toMatchObject({
    identity,
    status: 'accepted',
    observedUsage: null,
    usageStatus: 'unknown',
    terminalAt: null,
  });
  registry.observations.terminal(terminal);
  const complete = registry.observations.get('claim');
  registry.observations.terminal(terminal);
  expect(registry.observations.get('claim')).toEqual(complete);
  expect(registry.get('claim')?.state).toBe('reserved');
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.observations.get('claim')).toEqual(complete);
  reopened.close();
});
it('does not infer provider completion from controller cleanup or transport loss', () => {
  const { registry } = fixture();
  registry.observations.accept(identity);
  registry.markUncertain('claim');
  registry.markConfirmed('claim');
  expect(registry.observations.get('claim')).toMatchObject({
    status: 'accepted',
    terminalAt: null,
    observedUsage: null,
  });
  registry.close();
});
it('rejects unreserved, cross-session and changed revision/turn identities', () => {
  const { registry } = fixture();
  expect(() => registry.observations.accept({ ...identity, claimToken: 'missing' })).toThrow();
  expect(() => registry.observations.accept({ ...identity, sessionId: 'other' })).toThrow();
  registry.observations.accept(identity);
  for (const changed of [
    { providerTurnId: 'other' },
    { membershipGeneration: 3 },
    { accountBinding: { ...binding, profileRevision: 'account-v2' } },
  ])
    expect(() => registry.observations.accept({ ...identity, ...changed })).toThrow();
  expect(() =>
    registry.observations.terminal({ ...terminal, providerThreadId: 'other' }),
  ).toThrow();
  expect(() => registry.observations.terminal({ ...terminal, providerTurnId: 'other' })).toThrow();
  registry.observations.terminal(terminal);
  expect(() => registry.observations.terminal({ ...terminal, status: 'failed' })).toThrow();
  registry.close();
});
it.each(['failed', 'interrupted'] as const)(
  'preserves explicit provider %s without claiming success or usage',
  (status) => {
    const { registry } = fixture();
    registry.observations.accept(identity);
    registry.observations.terminal({ ...terminal, status });
    expect(registry.observations.get('claim')).toMatchObject({
      status,
      observedUsage: null,
      usageStatus: 'unknown',
    });
    registry.close();
  },
);

it('wires exact native callbacks into the reserved registry before completion and cleanup', async () => {
  const { createCodexNativeSeat } = await import('../symposium-codex-native.js');
  const { registry } = fixture();
  const execution = {
    sessionId: 'session',
    deliveryId: 'delivery',
    claimToken: 'claim',
    idempotencyKey: 'key',
    content: 'mock',
    signal: new AbortController().signal,
    seat: {
      id: 'writer',
      name: 'Writer',
      role: 'implementer',
      model: binding.model,
      accountBinding: binding,
      systemPrompt: '',
      color: '#123456',
    },
    provenance: identity.provenance,
  };
  const accepted = () => expect(registry.observations.get('claim')?.status).toBe('accepted');
  const native = await createCodexNativeSeat(
    {
      execution,
      route: { model: binding.model, effort: null, readOnly: false } as never,
      sandbox: { sandboxName: 'sandbox', workdir: '/work' },
      store: {} as never,
      attemptRegistry: registry,
      testConfirmStopped: async () => {
        expect(registry.observations.get('claim')?.status).toBe('completed');
      },
      createConversation: (options) => ({
        initialize: async () => {},
        getThreadId: () => 'thread',
        interrupt: async () => {},
        close() {},
        send: async (command) => {
          options.onProviderDispatch?.(command.id);
          expect(() => options.onProviderAccepted?.(command.id, 'other-thread', 'turn')).toThrow(
            'identity',
          );
          expect(registry.observations.get('claim')).toBeUndefined();
          options.onProviderAccepted?.(command.id, 'thread', 'turn');
          options.onProviderTerminal?.('other-claim', 'turn', 'completed');
          options.onProviderTerminal?.(command.id, 'other-turn', 'completed');
          expect(registry.observations.get('claim')?.status).toBe('accepted');
          options.onProviderTerminal?.(command.id, 'turn', 'completed');
          options.onProviderComplete?.(command.id, 'completed');
          options.onProviderTerminalConflict?.(
            command.id,
            'other-thread',
            'turn',
            'failed',
            'completed',
          );
          options.onProviderTerminalConflict?.(
            command.id,
            'thread',
            'other-turn',
            'failed',
            'completed',
          );
          expect(registry.observations.get('claim')?.terminalConflict).toBe(false);
          options.onProviderTerminalConflict?.(command.id, 'thread', 'turn', 'failed', 'completed');
          expect(registry.observations.get('claim')).toMatchObject({
            status: 'completed',
            terminalConflict: true,
          });
        },
      }),
    },
    {
      profile: {
        accountId: binding.accountId,
        accountLabel: binding.accountLabel,
        email: 'mock@example.test',
        planType: 'plus',
        model: binding.model,
      },
      verifyBinding: async () => binding,
      assertCommand() {},
    },
  );
  await native.run(execution, { beforeDispatch() {}, accepted });
  expect(registry.observations.get('claim')).toMatchObject({
    identity,
    status: 'completed',
    observedUsage: null,
  });
  registry.close();
});

it('persists conflicting terminal evidence without replacing the original observed result', () => {
  const { path, registry } = fixture();
  registry.observations.accept(identity);
  registry.observations.terminal(terminal);
  const original = registry.observations.get('claim');
  expect(() => registry.observations.terminal({ ...terminal, status: 'failed' })).toThrow();
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.observations.get('claim')).toEqual({ ...original, terminalConflict: true });
  reopened.close();
});

it('durably flags conflicting accepted-turn evidence before a completion hook finishes', () => {
  const { path, registry } = fixture();
  registry.observations.accept(identity);
  registry.observations.conflict({ ...terminal, status: 'failed', previousStatus: 'completed' });
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.observations.get('claim')).toMatchObject({
    status: 'accepted',
    terminalAt: null,
    terminalConflict: true,
    observedUsage: null,
  });
  reopened.close();
});
it('persists bounded final input metadata with exact claim and eligibility identity across reopen', () => {
  const { path, registry } = fixture();
  const receipt = {
    version: 1 as const,
    requestId: 3,
    commandId: 'claim',
    threadId: 'thread',
    inputCount: 1,
    inputs: [{ type: 'text' as const, utf8Bytes: 12, sha256: 'a'.repeat(64) }],
    inputUtf8Bytes: 40,
    inputSha256: 'b'.repeat(64),
    additionalContext: null,
    boundary: 'prepared' as const,
  };
  registry.observations.recordTurnInput('claim', 'session', identity.provenance, receipt);
  expect(registry.observations.getTurnInput('claim')).toMatchObject({
    claimToken: 'claim',
    sessionId: 'session',
    seatId: 'writer',
    ...receipt,
  });
  expect(() =>
    registry.observations.recordTurnInput('claim', 'session', identity.provenance, {
      ...receipt,
      commandId: 'other',
    }),
  ).toThrow();
  expect(() =>
    registry.observations.recordTurnInput('claim', 'session', identity.provenance, {
      ...receipt,
      inputs: [{ ...receipt.inputs[0], text: 'RAW-SECRET' }],
    } as never),
  ).toThrow();
  expect(() =>
    registry.observations.recordTurnInput('claim', 'session', identity.provenance, {
      ...receipt,
      boundary: 'write_completed',
    }),
  ).toThrow();
  registry.observations.recordTurnInput('claim', 'session', identity.provenance, {
    ...receipt,
    boundary: 'write_queued',
  });
  registry.observations.recordTurnInput('claim', 'session', identity.provenance, {
    ...receipt,
    boundary: 'write_completed',
  });
  const saved = registry.observations.getTurnInput('claim');
  registry.close();
  const reopened = new SymposiumAttemptRegistry(path);
  expect(reopened.observations.getTurnInput('claim')).toEqual(saved);
  expect(() =>
    reopened.observations.recordTurnInput('claim', 'session', identity.provenance, {
      ...receipt,
      requestId: 4,
    }),
  ).toThrow();
  reopened.close();
});
it('links acceptance to original source qualifier ordering without schema reordering', () => {
  const { registry } = fixture();
  const provenance = Object.fromEntries(
    Object.entries(identity.provenance).reverse(),
  ) as typeof identity.provenance;
  registry.observations.recordTurnInput('claim', 'session', provenance, {
    version: 1,
    requestId: 1,
    commandId: 'claim',
    threadId: 'thread',
    inputCount: 1,
    inputs: [{ type: 'text', utf8Bytes: 1, sha256: 'a'.repeat(64) }],
    inputUtf8Bytes: 20,
    inputSha256: 'b'.repeat(64),
    additionalContext: null,
    boundary: 'prepared',
  });
  expect(() => registry.observations.accept({ ...identity, provenance })).not.toThrow();
  registry.close();
});
