import { describe, expect, it, vi } from 'vitest';
import { dispatchOwnedOrdinaryCommand } from '../ordinary-scoped-command.js';

const calls = vi.hoisted(() => ({
  startCodex: vi.fn(),
  sendCodex: vi.fn(),
  startVertex: vi.fn(),
  sendVertex: vi.fn(),
  startShell: vi.fn(),
  sendShell: vi.fn(),
  startGemini: vi.fn(),
  sendGemini: vi.fn(),
}));
vi.mock('../chat.js', () => ({
  startOwnedLocalCodexCommand: calls.startCodex,
  sendOwnedLocalCodexCommand: calls.sendCodex,
  startOwnedLocalResponsesCommand: calls.startGemini,
  sendOwnedLocalResponsesCommand: calls.sendGemini,
}));
vi.mock('../ordinary-local-vertex-entry.js', () => ({
  startOwnedLocalVertexCommand: calls.startVertex,
  sendOwnedLocalVertexCommand: calls.sendVertex,
}));
vi.mock('../ordinary-openshell-codex-entry.js', () => ({
  startOwnedOpenShellCodexCommand: calls.startShell,
  sendOwnedOpenShellCodexCommand: calls.sendShell,
}));

function input(provider: 'openai' | 'openai-codex' | 'anthropic-vertex' = 'openai') {
  const binding = {
    accountId: 'selected',
    accountLabel: 'Selected',
    provider,
    profileRevision: 'r1',
    model: 'selected-model',
  };
  const runtimeBinding = {
    version: 2 as const,
    account: { accountId: binding.accountId, provider, profileRevision: binding.profileRevision },
    harness: {
      implementation:
        provider === 'anthropic-vertex' ? ('claude-sdk' as const) : ('codex' as const),
    },
    execution: {
      location: 'local' as const,
      targetId: 'selected-target',
      targetRevision: 'target-r1',
    },
  };
  return {
    transport: { isOpen: () => true, send: vi.fn() },
    clientId: 'selected-connection:worker',
    sessionId: 'worker',
    commandId: 'command',
    operatorConnectionId: 'operator',
    ownerConnectionId: 'selected-connection',
    ownerAuthSessionId: 'auth',
    signal: new AbortController().signal,
    continuation: false,
    existingOwner: false,
    workspaceKind: 'repository' as const,
    command: {
      clientMsgId: 'command',
      capabilityRevision: 'cap-r1',
      runtime: {
        account: structuredClone(runtimeBinding.account),
        harness: runtimeBinding.harness.implementation,
        targetId: 'selected-target',
        mode: 'agent',
      },
      selection: { model: binding.model, thinking: null, permission: { mode: 'agent' } },
      payload: { text: 'Reviewed worker objective' },
    },
    reservation: {
      id: 'workspace',
      binding,
      conversationId: 'worker',
      taskRoot: '/tmp/tasks',
      runtimeBinding,
      commandFingerprint: 'fingerprint',
    },
  };
}

describe('ordinary feature dispatch shares the ordinary owner', () => {
  it.each(['openai', 'openai-codex'] as const)(
    'dispatches %s through exact Codex admission without changing identity',
    async (provider) => {
      const selected = input(provider);
      calls.startCodex.mockResolvedValueOnce({ dispatched: true, sessionId: 'worker' });
      await expect(dispatchOwnedOrdinaryCommand(selected)).resolves.toEqual({
        dispatched: true,
        sessionId: 'worker',
      });
      expect(calls.startCodex).toHaveBeenLastCalledWith(
        selected.transport,
        selected.clientId,
        expect.objectContaining({
          command: selected.command,
          reservation: selected.reservation,
          commandId: 'command',
          operatorConnectionId: 'operator',
          signal: selected.signal,
        }),
      );
    },
  );

  it('uses the existing Claude SDK owner for a Claude selection', async () => {
    const selected = input('anthropic-vertex');
    await dispatchOwnedOrdinaryCommand(selected);
    expect(calls.startVertex).toHaveBeenLastCalledWith(
      selected.transport,
      selected.clientId,
      expect.objectContaining({ reservation: selected.reservation, command: selected.command }),
    );
  });

  it('keeps follow-ups in the existing admitted FIFO', async () => {
    const selected = { ...input(), continuation: true, existingOwner: true };
    await dispatchOwnedOrdinaryCommand(selected);
    expect(calls.sendCodex).toHaveBeenLastCalledWith({
      sessionId: 'worker',
      command: selected.command,
      operatorConnectionId: 'operator',
      signal: selected.signal,
    });
  });

  it('does not retry or choose a different owner after uncertain dispatch', async () => {
    calls.startCodex.mockRejectedValueOnce(Error('uncertain'));
    const count = calls.startVertex.mock.calls.length;
    await expect(dispatchOwnedOrdinaryCommand(input())).rejects.toThrow('uncertain');
    expect(calls.startVertex).toHaveBeenCalledTimes(count);
  });

  it('rejects mismatched runtime account before dispatch', async () => {
    const selected = input();
    selected.command.runtime.account.accountId = 'different-account';
    const count = calls.startCodex.mock.calls.length;
    await expect(dispatchOwnedOrdinaryCommand(selected)).rejects.toThrow(
      'Exact ordinary dispatch selection required',
    );
    expect(calls.startCodex).toHaveBeenCalledTimes(count);
  });
});
