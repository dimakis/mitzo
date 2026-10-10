import { expect, it, vi } from 'vitest';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { createOrdinarySymposiumTurn, type OrdinaryChatPort } from '../symposium-ordinary-turn.js';

function input(): SymposiumSeatExecution {
  return {
    sessionId: 'parent',
    deliveryId: 'delivery',
    content: 'Explicit excerpt.',
    idempotencyKey: 'recipient',
    claimToken: 'claim',
    signal: new AbortController().signal,
    seat: {
      id: 'contributor',
      name: 'Contributor',
      role: 'coder',
      model: 'offline-luna',
      systemPrompt: 'Selected guidance.',
      color: '#335577',
      accountBinding: {
        accountId: 'personal',
        accountLabel: 'Personal',
        provider: 'openai-codex',
        model: 'offline-luna',
        profileRevision: '1',
      },
    },
    provenance: {
      seatId: 'contributor',
      configRevision: 1,
      accountProfileRevision: '1',
      seatProfileRevision: '1',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'ordinary',
      isolationDomainRevision: 1,
      membershipGeneration: 1,
    },
  };
}

it('starts an independent ordinary session with exact account, mode, selected excerpt and guidance, then resumes it', async () => {
  const f = input();
  const stop = vi.fn();
  let options!: Parameters<OrdinaryChatPort['startChat']>[3];
  const port: OrdinaryChatPort = {
    stopChat: stop,
    startChat: vi.fn(async (transport, _client, _prompt, selection) => {
      options = selection;
      selection.ordinaryTurnLifecycle!.beforeDispatch('recipient');
      selection.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
      transport.send({ type: 'block_start', blockId: 'text', blockType: 'text' });
      transport.send({ type: 'block_delta', blockId: 'text', delta: 'Reply.' });
      selection.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'completed');
      selection.onTurnResult!({ is_error: false });
    }),
  };
  const callbacks = { beforeDispatch: vi.fn(), accepted: vi.fn() };
  const runner = createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/selected/task',
    mode: 'agent',
    newSessionId: () => 'ordinary-child',
  });
  await expect(runner.run(f, callbacks)).resolves.toEqual({
    providerThreadId: 'ordinary-child',
    content: 'Reply.',
  });
  expect(options.accountId).toBe('personal');
  expect(options.model).toBe('offline-luna');
  expect(options.mode).toBe('agent');
  expect(options.retainWorkspace).toBe(true);
  expect(options.contributorGuidance).toBe('Selected guidance.');
  expect(options.contextBlocks).toBeUndefined();
  expect(options.initialSessionId).toBe('ordinary-child');
  expect(options.telosTaskId).toBeUndefined();
  expect(stop).toHaveBeenCalledOnce();
  expect(callbacks.accepted).toHaveBeenCalledWith('ordinary-child', 'raw-turn');
  const resume = { ...f, providerThreadId: 'ordinary-child' };
  await createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/selected/task',
    mode: 'ask',
  }).run(resume, callbacks);
  expect(options.resume).toBe('ordinary-child');
  expect(options.initialSessionId).toBeUndefined();
});

it('rejects a stream closing without an exact provider terminal and keeps cancellation uncertain', async () => {
  const f = input();
  const port: OrdinaryChatPort = {
    stopChat: vi.fn(),
    startChat: async (_transport, _client, _prompt, options) => {
      options.ordinaryTurnLifecycle!.beforeDispatch('recipient');
      options.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
    },
  };
  const runner = createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/task',
    mode: 'agent',
  });
  await expect(runner.run(f, { beforeDispatch: () => {}, accepted: () => {} })).rejects.toThrow(
    /unconfirmed/,
  );
  await expect(runner.cancelAndDrain()).rejects.toThrow(/unconfirmed/);
});

it('Stop requests interruption and waits for matching provider completion and query close', async () => {
  const f = input();
  let options!: Parameters<OrdinaryChatPort['startChat']>[3];
  let close!: () => void;
  const ended = new Promise<void>((resolve) => {
    close = resolve;
  });
  const interrupt = vi.fn(async () => {});
  const port: OrdinaryChatPort = {
    stopChat: vi.fn(() => close()),
    startChat: async (_transport, _client, _prompt, selection) => {
      options = selection;
      selection.ordinaryTurnLifecycle!.beforeDispatch('recipient');
      selection.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
      selection.onQueryReady!({ interrupt });
      await ended;
    },
  };
  const runner = createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/task',
    mode: 'agent',
  });
  const running = runner.run(f, { beforeDispatch: () => {}, accepted: () => {} });
  const rejection = expect(running).rejects.toThrow(/cancelled/);
  await Promise.resolve();
  const cancellation = runner.cancelAndDrain();
  let drained = false;
  void cancellation.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(interrupt).toHaveBeenCalledOnce();
  expect(drained).toBe(false);
  options.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'interrupted');
  options.onTurnResult!({ is_error: true });
  await cancellation;
  await rejection;
  expect(drained).toBe(true);
});

it('allows an explicit later Stop to retry a rejected exact query interruption', async () => {
  vi.useFakeTimers();
  try {
    const f = input();
    let options!: Parameters<OrdinaryChatPort['startChat']>[3];
    let close!: () => void;
    const ended = new Promise<void>((resolve) => {
      close = resolve;
    });
    const interrupt = vi
      .fn()
      .mockRejectedValueOnce(new Error('interruption request failed'))
      .mockImplementationOnce(async () => {
        options.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'interrupted');
      });
    const port: OrdinaryChatPort = {
      stopChat: () => close(),
      startChat: async (_transport, _client, _prompt, selected) => {
        options = selected;
        selected.ordinaryTurnLifecycle!.beforeDispatch('recipient');
        selected.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
        selected.onQueryReady!({ interrupt });
        await ended;
      },
    };
    const runner = createOrdinarySymposiumTurn({
      port,
      binding: f.seat.accountBinding!,
      cwd: '/task',
      mode: 'agent',
      cancellationTimeoutMs: 10,
    });
    const running = runner
      .run(f, { beforeDispatch: () => {}, accepted: () => {} })
      .catch((error: unknown) => error);
    await Promise.resolve();
    const firstStop = runner.cancelAndDrain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await firstStop).toMatchObject({ message: expect.stringMatching(/unconfirmed/) });
    options.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
    await Promise.resolve();
    expect(interrupt).toHaveBeenCalledTimes(1);
    const secondStop = runner.cancelAndDrain().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await secondStop).toBeUndefined();
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(await running).toMatchObject({ message: expect.stringMatching(/cancelled/) });
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the cancellation deadline through query closure after an exact provider terminal', async () => {
  vi.useFakeTimers();
  try {
    const f = input();
    let options!: Parameters<OrdinaryChatPort['startChat']>[3];
    let close!: () => void;
    const ended = new Promise<void>((resolve) => {
      close = resolve;
    });
    const port: OrdinaryChatPort = {
      stopChat: vi.fn(),
      startChat: async (_transport, _client, _prompt, selected) => {
        options = selected;
        selected.ordinaryTurnLifecycle!.beforeDispatch('recipient');
        selected.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
        selected.onQueryReady!({
          interrupt: async () => {
            options.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'interrupted');
          },
        });
        await ended;
      },
    };
    const runner = createOrdinarySymposiumTurn({
      port,
      binding: f.seat.accountBinding!,
      cwd: '/task',
      mode: 'agent',
      cancellationTimeoutMs: 10,
    });
    const running = runner
      .run(f, { beforeDispatch: () => {}, accepted: () => {} })
      .catch((error: unknown) => error);
    await Promise.resolve();
    let stopResult: unknown = 'pending';
    const stopping = runner.cancelAndDrain().then(
      () => {
        stopResult = 'confirmed';
      },
      (error: unknown) => {
        stopResult = error;
      },
    );
    await vi.advanceTimersByTimeAsync(11);
    expect(stopResult).toMatchObject({ message: expect.stringMatching(/unconfirmed/) });
    close();
    await stopping;
    expect(await running).toMatchObject({ message: expect.stringMatching(/cancelled/) });
    await expect(runner.cancelAndDrain()).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('refuses implicit account routing and providers without exact lifecycle receipts', () => {
  const f = input();
  const port = { startChat: vi.fn(), stopChat: vi.fn() };
  expect(() =>
    createOrdinarySymposiumTurn({
      port,
      binding: { ...f.seat.accountBinding!, provider: 'openai' },
      cwd: '/task',
      mode: 'agent',
    }),
  ).toThrow(/lifecycle/);
});

it('keeps saved seat guidance immutable while appending separate user guidance', async () => {
  const f = input();
  let guide = '';
  const port: OrdinaryChatPort = {
    stopChat: () => {},
    startChat: async (_transport, _client, _prompt, options) => {
      guide = options.contributorGuidance!;
      options.ordinaryTurnLifecycle!.beforeDispatch('recipient');
      options.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
      options.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'completed');
      options.onTurnResult!({ is_error: false });
    },
  };
  await createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/task',
    mode: 'agent',
    additionalGuidance: 'Focus on accessibility.',
  }).run(f, { beforeDispatch: () => {}, accepted: () => {} });
  expect(guide).toBe(
    'Selected guidance.\n\nAdditional user guidance for this contributor session:\nFocus on accessibility.',
  );
  expect(f.seat.systemPrompt).toBe('Selected guidance.');
});

it('includes saved expected output and acceptance criteria before separate user guidance', async () => {
  const f = input();
  f.seat.expectedOutput = 'A concise edited document.';
  f.seat.acceptanceCriteria = ['Preserve the original intent.', 'Explain unresolved questions.'];
  const original = structuredClone(f.seat);
  let guide = '';
  const port: OrdinaryChatPort = {
    stopChat: () => {},
    startChat: async (_transport, _client, _prompt, options) => {
      guide = options.contributorGuidance!;
      options.ordinaryTurnLifecycle!.beforeDispatch('recipient');
      options.ordinaryTurnLifecycle!.accepted('recipient', 'raw-thread', 'raw-turn');
      options.ordinaryTurnLifecycle!.terminal('recipient', 'raw-turn', 'completed');
      options.onTurnResult!({ is_error: false });
    },
  };
  await createOrdinarySymposiumTurn({
    port,
    binding: f.seat.accountBinding!,
    cwd: '/task',
    mode: 'agent',
    additionalGuidance: 'Focus on accessibility.',
  }).run(f, { beforeDispatch: () => {}, accepted: () => {} });
  expect(guide).toBe(
    'Selected guidance.\n\nExpected output: A concise edited document.\n\nAcceptance criteria:\n- Preserve the original intent.\n- Explain unresolved questions.\n\nAdditional user guidance for this contributor session:\nFocus on accessibility.',
  );
  expect(f.seat).toEqual(original);
});
