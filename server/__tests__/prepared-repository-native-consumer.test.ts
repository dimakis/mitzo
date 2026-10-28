import { fixture, physical, git } from './fixtures/prepared-repository-native-consumer.js';
import { CodexConversation } from '../codex-conversation.js';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { reconcilePreparedRepositoryTransitionProjection } from '../owned-prepared-repository-transition.js';
import { captureAgentLibraryAuthorization } from '../agent-library-transport.js';
import { RetainedLocalCodexRecovery } from '../retained-local-codex-recovery.js';

it('adopts through the genuine retained bootstrap selection and actual repository CAS, then validates later add/commit without recursion', async () => {
  const f = await fixture();
  await writeFile(join(f.first.workspace.directory!, 'dirty.txt'), 'Retain original work');
  const result = await f.adopt();
  expect(result?.id).toBe(f.record.id);
  f.setCwd(result!.directory);
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.record.id);
  expect(f.events.getSession(f.first.sessionId)?.cwd).toBe(result!.directory);
  expect(f.native.read(f.first.sessionId, f.first.lease.binding).cwd).toBe(result!.directory);
  const child = f.native
    .commands(f.first.sessionId, f.first.lease.binding)
    .find((command) => command.status === 'queued')!;
  expect(child.environmentContinuation).toEqual({
    sourceCommandId: f.source.commandId,
    sourceThreadId: f.source.threadId,
    sourceTurnId: f.source.turnId,
    sourceGeneration: f.source.generation,
  });
  expect(f.events.observePreparedRepositoryContinuation(child.id).state).toBe('consumed');
  expect(f.admission.nativeExecutionWorkspace(child.id).cwd).toBe(result!.directory);
  expect(await readFile(join(f.first.workspace.directory!, 'dirty.txt'), 'utf8')).toBe(
    'Retain original work',
  );
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.first.lease.client).toBe(f.rpc);
  await writeFile(join(result!.directory, 'task.txt'), 'Legitimate new task work');
  git(result!.directory, 'add', '.');
  git(result!.directory, 'commit', '-qm', 'task change');
  await f.first.lease.assertCurrent();
  expect(f.disposals).toHaveBeenCalled();
});

it('retains the controlled prepared reader during Linux adoption without loading the real native factory', async () => {
  const f = await fixture();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const readerCalls = physical.reader.mock.calls.length;
  const creationCalls = physical.creation.mock.calls.length;
  try {
    // Only adoption uses the Linux branch. Bootstrap and executable guards
    // already ran; this fixture retains its existing controlled read transport.
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const result = await f.adopt();
    expect(result?.id).toBe(f.record.id);
    expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.record.id);
    expect(f.events.getSession(f.first.sessionId)?.cwd).toBe(result!.directory);
    expect(physical.reader.mock.calls.length).toBeGreaterThan(readerCalls);
    expect(physical.creation.mock.calls.length).toBeGreaterThan(creationCalls);
    expect(f.disposals).toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

it('admits a later explicit follow-up through the actual adopted primary and unchanged original bootstrap', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  const followup = {
    ...structuredClone(f.request),
    clientMsgId: 'explicit-followup',
    payload: { text: 'Continue in the adopted primary' },
  };
  await expect(f.runtime.admitContinuation(followup)).resolves.toEqual({ dispatched: true });
  expect(f.admission.nativeExecutionWorkspace(followup.clientMsgId).cwd).toBe(result!.directory);
});

it('serializes config and metadata-only thread resume for the adopted primary on the already qualified client', async () => {
  const f = await fixture();
  const result = await f.adopt();
  f.setCwd(result!.directory);
  // Reinitialize the retained thread on the SAME admitted lease and SAME
  // mocked client. No new bootstrap, creation actor or model call occurs.
  const originalRequest = f.rpc.request.getMockImplementation()!;
  const request = vi.spyOn(f.first.lease.client, 'request');
  const packets: Array<{ method: string; params: Record<string, unknown> }> = [];
  request.mockImplementation(async (method, params) => {
    packets.push({ method, params });
    if (method === 'thread/resume')
      return {
        thread: { id: 'thread' },
        model: f.first.lease.binding.model,
        modelProvider: 'openai',
      };
    return originalRequest(method);
  });
  const policy = codexNativeExecutionPolicy({
    bindingRevision: f.first.lease.binding.profileRevision!,
    mode: 'agent',
    cwd: result!.directory,
    readableRoots: ['/'],
    writableRoots: [result!.directory],
    deniedRoots: [join(f.root, 'login'), join(f.root, 'custody')],
    writeProtectedRoots: [],
  });
  const retained = new CodexConversation({
    conversationId: f.first.sessionId,
    cwd: result!.directory,
    profile: f.first.profile,
    storedBinding: f.first.lease.binding,
    store: f.native,
    systemPrompt: f.first.payload.systemPrompt,
    tools: [],
    // Packet-only reinitialization on the already attached client. The existing
    // bridge remains one-shot; this does not qualify post-loss reattachment.
    createClient: () => f.first.lease.client,
    emit: () => {},
    executeTool: async () => {
      throw Error('No tool dispatch during reinitialization');
    },
    verifyBinding: async () => {
      await f.admission.assertCurrent();
      return f.first.lease.binding;
    },
    nativeExecution: policy,
    assertNativeExecutionCurrent: () => f.admission.assertCurrentSync(),
    requestNativeApproval: async () => ({ decision: 'decline' }),
    startupSignal: f.signal.signal,
    transportClosure: 'terminal',
  });
  try {
    await retained.initialize();
    const configs = packets.filter((packet) => packet.method === 'config/read');
    expect(configs.length).toBeGreaterThan(0);
    expect(configs.every((packet) => packet.params.cwd === result!.directory)).toBe(true);
    expect(packets.find((packet) => packet.method === 'thread/resume')?.params).toMatchObject({
      threadId: 'thread',
      cwd: result!.directory,
      permissions: policy.permissions,
    });
    expect(
      packets.some((packet) => packet.method === 'thread/start' || packet.method === 'turn/start'),
    ).toBe(false);
    expect(retained.getThreadId()).toBe('thread');
    expect(f.launch).toHaveBeenCalledOnce();
  } finally {
    retained.close();
  }
});

it.each(['already-queued', 'during-capture', 'at-reservation'] as const)(
  'adopts with %s explicit steering, retaining original admission and FIFO without an automatic turn',
  async (phase) => {
    const f = await fixture();
    const followup = {
      ...structuredClone(f.request),
      clientMsgId: 'held-explicit-steering',
      payload: { text: 'Stop the original task and explain the changes' },
    };
    const enqueue = () => f.runtime.admitContinuation(followup);
    let pending: ReturnType<typeof enqueue> | undefined;
    if (phase === 'already-queued') await enqueue();
    else if (phase === 'at-reservation') {
      const reserve = f.events.reservePreparedRepositoryContinuation.bind(f.events);
      vi.spyOn(f.events, 'reservePreparedRepositoryContinuation').mockImplementationOnce(
        (...args) => {
          pending = enqueue();
          void pending.catch(() => {});
          return reserve(...args);
        },
      );
    } else {
      const original = physical.creation.getMockImplementation()!;
      physical.creation.mockImplementationOnce(async (...args) => {
        const value = await original(...args);
        pending = enqueue();
        void pending.catch(() => {});
        return value;
      });
    }
    const historical =
      phase === 'already-queued' && f.events.getOrdinaryLocalCommandAdmission(followup.clientMsgId);
    const result = await f.adopt();
    if (pending) await expect(pending).resolves.toEqual({ dispatched: true });
    expect(result?.directory).toBe(f.record.pendingHostTask?.directory);
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((command) => command.status === 'queued')
        .map((command) => command.id),
    ).toEqual([followup.clientMsgId]);
    expect(f.admission.nativeExecutionWorkspace(followup.clientMsgId).cwd).toBe(result!.directory);
    expect(f.events.getSendCommand(followup.clientMsgId)?.payload.text).toBe(followup.payload.text);
    if (historical) {
      expect(
        f.events.getPreparedRepositoryCommandAdmissionEvidence(
          followup.clientMsgId,
          f.events.getOrdinaryLocalCommandExecutionAdmission(followup.clientMsgId)!
            .preparedRepositoryPrimaryCommandId!,
        ),
      ).toEqual(historical);
      // Reopen exactly the retained input in its adopted execution workspace.
      // Its original consumed receipt still belongs to the earlier workspace.
      const execution = f.events.getOrdinaryLocalCommandExecutionAdmission(followup.clientMsgId)!;
      expect(execution.workspace.cwd).toBe(result!.directory);
      expect(execution.workspace).not.toEqual(historical.workspace);
      expect(() =>
        RetainedLocalCodexRecovery.capture(f.events, f.native, f.first.sessionId, f.auth.id, {
          ...followup,
          payload: { text: 'Different steering' },
        }),
      ).toThrow();
      const proof = RetainedLocalCodexRecovery.capture(
        f.events,
        f.native,
        f.first.sessionId,
        f.auth.id,
        followup,
      );
      expect(() => proof.complete()).toThrow();
      expect(
        proof.claim(
          { ...f.first.expected, workspace: execution.workspace, selection: execution.selection },
          f.events.getSendCommand(followup.clientMsgId)!.payload,
        ),
      ).toBe(true);
      const genericCompletion = vi.spyOn(f.events, 'completeOrdinaryLocalCommand');
      proof.complete();
      expect(genericCompletion).not.toHaveBeenCalled();
      expect(() => proof.complete()).toThrow();
      expect(
        f.events.getPreparedRepositoryCommandAdmissionEvidence(
          followup.clientMsgId,
          execution.preparedRepositoryPrimaryCommandId!,
        ),
      ).toEqual(historical);
      expect(f.events.getSendCommand(followup.clientMsgId)?.payload.text).toBe(
        followup.payload.text,
      );
      expect(f.events.getOrdinaryLocalCommandExecutionAdmission(followup.clientMsgId)).toEqual(
        execution,
      );
      genericCompletion.mockRestore();
    }
    expect(f.native.read(f.first.sessionId, f.first.lease.binding).recovery).toBe(0);
    expect(f.native.claimNext(f.first.sessionId, f.first.lease.binding)?.id).toBe(
      followup.clientMsgId,
    );
    f.admission.assertBeforeDispatch(followup.clientMsgId);
  },
);

it('drains both earlier admissions before installing the transition barrier', async () => {
  const f = await fixture();
  let unblock!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const qualifying = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const original = f.rpc.request.getMockImplementation()!;
  f.rpc.request.mockImplementationOnce(async (...args) => {
    reached();
    await held;
    return original(...args);
  });
  const command = (id: string) => ({
    ...structuredClone(f.request),
    clientMsgId: id,
    payload: { text: id },
  });
  const first = f.runtime.admitContinuation(command('pre-transition-a'));
  await qualifying;
  const second = f.runtime.admitContinuation(command('pre-transition-b'));
  const candidate = vi.spyOn(f.workspace, 'findPreparedRepositoryTransitionCandidate');
  const adoption = f.adopt();
  await vi.waitFor(() => expect(candidate).toHaveBeenCalled());
  unblock();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([first, second, adoption]),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error('Earlier admissions deadlocked behind their own transition')),
          15000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  expect(
    f.native
      .commands(f.first.sessionId, f.first.lease.binding)
      .filter((c) => c.status === 'queued')
      .map((c) => c.id),
  ).toEqual(['pre-transition-a', 'pre-transition-b']);
});

it('refuses queued old-workspace work before child reservation or repository custody changes', async () => {
  const f = await fixture();
  f.native.enqueue(f.first.sessionId, f.first.lease.binding, {
    id: 'later-user',
    prompt: 'Later user command',
  });
  await expect(f.adopt()).rejects.toThrow();
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
  expect(
    f.native
      .commands(f.first.sessionId, f.first.lease.binding)
      .filter((command) => command.environmentContinuation),
  ).toHaveLength(0);
});

it.each(['close-during-capture', 'queue-during-capture'] as const)(
  'refuses %s through the original real barrier before reserving or adopting',
  async (phase) => {
    const f = await fixture();
    const original = physical.creation.getMockImplementation()!;
    physical.creation.mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      if (phase === 'close-during-capture') f.runtime.close();
      else
        f.native.enqueue(f.first.sessionId, f.first.lease.binding, {
          id: 'raced-followup',
          prompt: 'Later explicit user request',
        });
      return value;
    });
    const cas = vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition');
    await expect(f.adopt()).rejects.toThrow();
    expect(cas).not.toHaveBeenCalled();
    expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((command) => command.environmentContinuation),
    ).toHaveLength(0);
  },
);

it('renews an untransferred preparation after restart without treating its reservation as an executed custody effect', async () => {
  const f = await fixture();
  const custody = vi
    .spyOn(f.workspace, 'adoptPreparedRepositoryTransition')
    .mockImplementationOnce(() => {
      throw Error('Process stopped before custody CAS');
    });
  await expect(f.adopt()).rejects.toThrow();
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
  expect(
    f.native.hasPreparedRepositoryTransitionHold(f.first.sessionId, f.first.lease.binding),
  ).toBe(true);
  expect(f.events.hasUncertainOrdinaryCommand(f.first.sessionId)).toBe(true);
  const operator = captureAgentLibraryAuthorization(f.dependencies.operatorConnectionId);
  reconcilePreparedRepositoryTransitionProjection({
    workspace: f.workspace,
    events: f.events,
    native: f.native,
    conversationId: f.first.sessionId,
    binding: f.first.lease.binding,
    assertCurrentSync: () => operator.assertCurrent(),
  });
  expect(f.events.hasUncertainOrdinaryCommand(f.first.sessionId)).toBe(false);
  expect(f.workspace.getForConversation(f.first.sessionId)?.id).toBe(f.first.workspace.id);
  expect(custody).toHaveBeenCalledOnce();
  expect(
    f.native
      .commands(f.first.sessionId, f.first.lease.binding)
      .filter((command) => command.status === 'queued'),
  ).toHaveLength(0);
});

it.each(['event-projection', 'native-projection', 'native-projection-after-write'] as const)(
  'reconciles %s after custody committed without repeating allocation, custody transfer or provider work',
  async (phase) => {
    const f = await fixture();
    const custody = vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition');
    if (phase === 'event-projection')
      vi.spyOn(f.events, 'commitPreparedRepositoryContinuation').mockImplementationOnce(() => {
        throw Error('Simulated event projection crash');
      });
    else {
      const write = f.native.adoptPreparedRepositoryWorkspace.bind(f.native);
      vi.spyOn(f.native, 'adoptPreparedRepositoryWorkspace').mockImplementationOnce((...args) => {
        if (phase === 'native-projection-after-write') write(...args);
        throw Error('Simulated native projection crash');
      });
    }
    await expect(f.adopt()).rejects.toThrow();
    expect(custody).toHaveBeenCalledOnce();
    const adopted = f.workspace.getForConversation(f.first.sessionId)!;
    expect(adopted.id).toBe(f.record.id);
    const operator = captureAgentLibraryAuthorization(f.dependencies.operatorConnectionId);
    const owners = {
      workspace: f.workspace,
      events: f.events,
      native: f.native,
      conversationId: f.first.sessionId,
      binding: f.first.lease.binding,
      assertCurrentSync: () => operator.assertCurrent(),
    };
    expect(reconcilePreparedRepositoryTransitionProjection(owners)?.directory).toBe(
      adopted.directory,
    );
    expect(f.events.getSession(f.first.sessionId)?.cwd).toBe(adopted.directory);
    expect(f.native.read(f.first.sessionId, f.first.lease.binding).cwd).toBe(adopted.directory);
    expect(
      f.native
        .commands(f.first.sessionId, f.first.lease.binding)
        .filter((command) => command.status === 'queued'),
    ).toHaveLength(0);
    expect(reconcilePreparedRepositoryTransitionProjection(owners)?.directory).toBe(
      adopted.directory,
    );
    expect(custody).toHaveBeenCalledOnce();
  },
);

it('retains actual cross-store uncertainty and refuses a replay after native cwd persistence fails', async () => {
  const f = await fixture();
  const original = f.native.adoptPreparedRepositoryWorkspace.bind(f.native);
  vi.spyOn(f.native, 'adoptPreparedRepositoryWorkspace').mockImplementation((...args) => {
    original(...args);
    throw Error('Lost native cwd commit acknowledgment');
  });
  const cas = vi.spyOn(f.workspace, 'adoptPreparedRepositoryTransition');
  await expect(f.adopt()).rejects.toThrow('Lost native cwd');
  expect(cas).toHaveBeenCalledOnce();
  const record = f.workspace.getForConversation(f.first.sessionId)!;
  const childId = record.preparedRepositoryTransitionAdoption!.childCommandId;
  expect(record.id).toBe(f.record.id);
  expect(f.events.observePreparedRepositoryContinuation(childId).state).toBe('uncertain');
  expect(() => f.admission.canClaimCommand(childId)).toThrow();
  const reopened = new CodexConversationStore(join(f.root, 'native-transition.db'));
  try {
    expect(reopened.read(f.first.sessionId, f.first.lease.binding).cwd).toBe(record.directory);
    expect(
      reopened
        .commands(f.first.sessionId, f.first.lease.binding)
        .some((command) => command.id === childId),
    ).toBe(false);
  } finally {
    reopened.close();
  }
  await expect(f.adopt()).rejects.toThrow();
  expect(cas).toHaveBeenCalledOnce();
  expect(await readFile(join(f.first.workspace.directory!, 'task.txt'), 'utf8')).toBe(
    'accepted source',
  );
});
