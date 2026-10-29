import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  CodexConversationStore,
  preparedRepositoryResultSha256,
} from '../codex-conversation-store.js';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';

const binding = {
  accountId: 'fixture-account',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline',
  profileRevision: 'revision',
};
const result = { content: '{"preparationId":"prepared"}', isError: false };
const source = {
  commandId: 'original',
  attempt: 1,
  threadId: 'thread',
  turnId: 'turn',
  generation: 0,
  callId: 'prepare-call',
  toolName: 'PrepareLocalRepository' as const,
  requestHash: 'a'.repeat(64),
  resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
};
const cleanups: Array<() => void> = [];
it('hashes the actual retained public result, excluding private executor fields', () => {
  const privateResult = { ...result, environmentRefresh: true };
  expect(preparedRepositoryResultSha256(privateResult)).toBe(source.resultSha256);
  expect(
    preparedRepositoryResultSha256({
      content: result.content + '\nFinal host directive',
      isError: false,
    }),
  ).not.toBe(source.resultSha256);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(options: { ack?: boolean; result?: boolean; error?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-prepared-boundary-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'native.db');
  const store = new CodexConversationStore(path);
  cleanups.push(() => store.close());
  store.create('conversation', binding, '/original');
  store.bindThread('conversation', binding, 'thread');
  store.enqueue('conversation', binding, {
    id: 'original',
    prompt: 'Original user request',
    intent: 'Original authorized task',
  });
  const command = store.claimNext('conversation', binding)!;
  store.prepareNativeExecution(
    'conversation',
    binding,
    command,
    'thread',
    codexNativeExecutionPolicy({
      bindingRevision: 'binding',
      mode: 'agent',
      cwd: '/original',
      readableRoots: ['/selected'],
      writableRoots: ['/original'],
      deniedRoots: ['/credentials'],
      writeProtectedRoots: [],
    }),
  );
  if (options.ack !== false) {
    store.recordNativeTurnAck('conversation', binding, command, 'thread', 'turn');
    store.acceptNativeExecution('conversation', binding, command, 'thread', 'turn');
  }
  store.claimTool('conversation', binding, command.id, source.callId, source);
  if (options.result !== false)
    store.recordToolResult(
      'conversation',
      binding,
      command.id,
      source.callId,
      source,
      options.error ? { ...result, isError: true } : result,
    );
  return { store, command, path };
}

it('retains only the exact successful Prepare after matching completed native terminal, including reconnect', () => {
  const f = fixture();
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).toThrow();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).not.toThrow();
  const reopened = new CodexConversationStore(f.path);
  try {
    expect(() =>
      reopened.assertCompletedPreparedRepositorySource('conversation', binding, source),
    ).not.toThrow();
  } finally {
    reopened.close();
  }
  expect(f.store.commands('conversation', binding)[0]).toMatchObject({
    id: 'original',
    prompt: 'Original user request',
    intent: 'Original authorized task',
    status: 'completed',
  });
});

it.each(['interrupted', 'failed'] as const)(
  'refuses %s terminal without reclassifying or retrying the original task',
  (status) => {
    const f = fixture();
    f.store.finish('conversation', binding, 'original', status, 'turn');
    expect(() =>
      f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
    ).toThrow();
    expect(f.store.commands('conversation', binding)).toHaveLength(1);
  },
);

it.each([{ ack: false }, { result: false }, { error: true }])(
  'refuses missing acknowledgement or incomplete/failed result %j',
  (options) => {
    const f = fixture(options);
    f.store.finish('conversation', binding, 'original', 'completed', 'turn');
    expect(() =>
      f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
    ).toThrow();
  },
);

it('refuses altered source identities, hashes, account, or a mismatching terminal', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  for (const changed of [
    { attempt: 2 },
    { generation: 1 },
    { commandId: 'other' },
    { threadId: 'other' },
    { turnId: 'other' },
    { callId: 'other' },
    { requestHash: 'b'.repeat(64) },
    { resultSha256: 'b'.repeat(64) },
    { toolName: 'Write' },
  ])
    expect(() =>
      f.store.assertCompletedPreparedRepositorySource('conversation', binding, {
        ...source,
        ...changed,
      } as typeof source),
    ).toThrow();
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource(
      'conversation',
      { ...binding, accountId: 'other' },
      source,
    ),
  ).toThrow();
  const wrong = fixture();
  wrong.store.finish('conversation', binding, 'original', 'completed', 'another-terminal');
  expect(() =>
    wrong.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).toThrow();
});

it('refuses adoption when an old-workspace follow-up is queued, without altering FIFO or historical evidence', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  f.store.enqueue('conversation', binding, {
    id: 'followup',
    prompt: 'Queued with original workspace',
  });
  const before = f.store.commands('conversation', binding);
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).toThrow();
  expect(f.store.commands('conversation', binding)).toEqual(before);
});

it('queues only one exact original-task child after the completed boundary, retaining thread/history', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  const input = {
    id: 'prepared-repository-' + 'f'.repeat(64),
    prompt: 'Continue retained task',
    intent: 'Original authorized task',
    model: 'offline',
  };
  expect(
    f.store.enqueuePreparedRepositoryContinuation('conversation', binding, source, input),
  ).toBe(true);
  expect(() =>
    f.store.assertQueuedPreparedRepositoryContinuation('conversation', binding, source, input),
  ).not.toThrow();
  expect(() =>
    f.store.assertQueuedPreparedRepositoryContinuation('conversation', binding, source, {
      ...input,
      prompt: 'Changed',
    }),
  ).toThrow();
  expect(() =>
    f.store.enqueuePreparedRepositoryContinuation('conversation', binding, source, input),
  ).toThrow();
  const child = f.store.claimNext('conversation', binding)!;
  expect(child).toMatchObject({
    ...input,
    environmentContinuation: {
      sourceCommandId: 'original',
      sourceTurnId: 'turn',
      sourceThreadId: 'thread',
      sourceGeneration: 0,
    },
  });
  expect(f.store.commands('conversation', binding)).toHaveLength(2);
  expect(f.store.read('conversation', binding)).toMatchObject({
    threadId: 'thread',
    threadGeneration: 0,
  });
});

it('refuses a bounded-tools or automatic-child source before reserving adoption effects', () => {
  for (const extra of [
    { allowedTools: ['Read'] },
    {
      environmentContinuation: {
        sourceCommandId: 'earlier',
        sourceTurnId: 'earlier-turn',
        sourceThreadId: 'thread',
        sourceGeneration: 0,
      },
    },
  ]) {
    const f = fixture();
    f.store.finish('conversation', binding, 'original', 'completed', 'turn');
    const db = new Database(f.path);
    try {
      db.prepare('UPDATE codex_commands SET input=? WHERE conversation_id=? AND id=?').run(
        JSON.stringify({
          id: 'original',
          prompt: 'Original user request',
          intent: 'Original authorized task',
          ...extra,
        }),
        'conversation',
        'original',
      );
    } finally {
      db.close();
    }
    expect(() =>
      f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
    ).toThrow();
  }
});

it('discovers only the exact latest completed source and derives the digest from its durable result', () => {
  const f = fixture();
  expect(f.store.completedNativeTurnTarget('conversation', binding)).toBeUndefined();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  const target = {
    commandId: source.commandId,
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  };
  expect(f.store.completedNativeTurnTarget('conversation', binding)).toEqual(target);
  expect(
    f.store.completedPreparedRepositoryResultSha256(
      'conversation',
      binding,
      target,
      source.callId,
      source.requestHash,
    ),
  ).toBe(source.resultSha256);
  expect(() =>
    f.store.completedPreparedRepositoryResultSha256(
      'conversation',
      binding,
      { ...target, turnId: 'other' },
      source.callId,
      source.requestHash,
    ),
  ).toThrow();
  f.store.enqueue('conversation', binding, { id: 'next', prompt: 'Another task' });
  f.store.claimNext('conversation', binding);
  f.store.finish('conversation', binding, 'next', 'failed');
  expect(f.store.completedNativeTurnTarget('conversation', binding)).toBeUndefined();
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).toThrow();
});

it('changes only current native workspace after the operation boundary and keeps old policy receipts intact across reopen', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  const before = f.store.readNativeExecutionHistory('conversation', binding, 'original');
  f.store.adoptPreparedRepositoryWorkspace(
    'conversation',
    binding,
    source,
    '/original',
    '/prepared',
  );
  expect(f.store.read('conversation', binding)).toMatchObject({
    cwd: '/prepared',
    threadId: 'thread',
    threadGeneration: 0,
  });
  expect(f.store.readNativeExecutionHistory('conversation', binding, 'original')).toEqual(before);
  expect(() =>
    f.store.adoptPreparedRepositoryWorkspace(
      'conversation',
      binding,
      source,
      '/original',
      '/other',
    ),
  ).toThrow();
  const reopened = new CodexConversationStore(f.path);
  try {
    expect(() => reopened.create('conversation', binding, '/prepared')).not.toThrow();
  } finally {
    reopened.close();
  }
});

it('verifies adopted-primary recovery custody without replaying its interrupted command', () => {
  const f = fixture();
  f.store.pauseForRecovery(
    'conversation',
    binding,
    'original',
    'interrupted',
    'resume',
    undefined,
    true,
    true,
  );
  const before = f.store.commands('conversation', binding);
  expect(() =>
    f.store.assertPreparedRepositoryRecovery('conversation', binding, 'original'),
  ).not.toThrow();
  expect(f.store.commands('conversation', binding)).toEqual(before);
  expect(f.store.read('conversation', binding).recovery).toBe(1);
  f.store.acknowledgeRecovery('conversation', binding);
  expect(() =>
    f.store.assertPreparedRepositoryRecovery('conversation', binding, 'original'),
  ).not.toThrow();
  expect(f.store.commandStatus('conversation', binding, 'original')).toBe('interrupted');
});

it('refuses recovery ownership when an interrupted primary lacks accepted native execution evidence', () => {
  const f = fixture({ ack: false });
  f.store.pauseForRecovery(
    'conversation',
    binding,
    'original',
    'interrupted',
    'resume',
    undefined,
    true,
    true,
  );
  expect(() =>
    f.store.assertPreparedRepositoryRecovery('conversation', binding, 'original'),
  ).toThrow();
});

it('holds existing and late explicit messages behind one prepared workspace transition without changing FIFO evidence', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  f.store.enqueue('conversation', binding, { id: 'first', prompt: 'Stop the original task' });
  const before = f.store.commands('conversation', binding);
  const fence = f.store.holdPreparedRepositoryTransition('conversation', binding, source);
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource('conversation', binding, source),
  ).toThrow();
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource(
      'conversation',
      binding,
      source,
      undefined,
      fence,
    ),
  ).not.toThrow();
  expect(f.store.claimNext('conversation', binding)).toBeUndefined();
  f.store.enqueue('conversation', binding, {
    id: 'late',
    prompt: 'Use low reasoning',
    model: 'offline',
    reasoningEffort: 'low',
  });
  expect(f.store.claimNext('conversation', binding)).toBeUndefined();
  expect(f.store.commands('conversation', binding).slice(0, before.length)).toEqual(before);
  expect(f.store.read('conversation', binding).recovery).toBe(0);
  expect(
    f.store
      .commands('conversation', binding)
      .filter((command) => command.status === 'queued')
      .map((command) => command.id),
  ).toEqual(['first', 'late']);
  expect(() =>
    f.store.assertCompletedPreparedRepositorySource(
      'conversation',
      binding,
      { ...source, resultSha256: 'e'.repeat(64) },
      undefined,
      fence,
    ),
  ).toThrow();
});

it('permits only an unused settled native preparation and refuses pending tools, work or transition holds', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  const record = {
    id: 'unused-preparation',
    pendingHostTask: {
      request: {
        conversationId: 'conversation',
        binding,
        nativeTarget: f.store.completedNativeTurnTarget('conversation', binding),
      },
      directory: '/unused-task',
    },
  };
  expect(() => f.store.assertUnusedNativePreparation(record as never)).not.toThrow();
  f.store.holdPreparedRepositoryTransition('conversation', binding, source);
  expect(() => f.store.assertUnusedNativePreparation(record as never)).toThrow();
  const pending = fixture({ result: false });
  pending.store.finish('conversation', binding, 'original', 'completed', 'turn');
  expect(() => pending.store.assertUnusedNativePreparation(record as never)).toThrow();
  const queued = fixture();
  queued.store.finish('conversation', binding, 'original', 'completed', 'turn');
  queued.store.enqueue('conversation', binding, { id: 'new-work', prompt: 'Keep working' });
  expect(() => queued.store.assertUnusedNativePreparation(record as never)).toThrow();
});

it('verifies a stopped repository task without acknowledging recovery or releasing queued work', () => {
  const f = fixture();
  f.store.finish('conversation', binding, 'original', 'completed', 'turn');
  const record = {
    id: 'owned-task',
    conversationId: 'conversation',
    binding,
    directory: '/original',
  };
  expect(() => f.store.assertRepositoryTaskStopped(record as never)).not.toThrow();
  f.store.enqueue('conversation', binding, { id: 'pending', prompt: 'Continue' });
  expect(() => f.store.assertRepositoryTaskStopped(record as never)).toThrow();
  expect(f.store.commandStatus('conversation', binding, 'pending')).toBe('queued');
});

it.each([false, true])(
  'selects a completed preparation source only for a successful durable tool result (error=%s)',
  (error) => {
    const f = fixture({ error });
    f.store.finish('conversation', binding, f.command.id, 'completed', 'turn');
    const target = f.store.completedPreparedRepositorySourceTarget('conversation', binding);
    expect(target).toEqual(
      error
        ? undefined
        : {
            commandId: source.commandId,
            attempt: source.attempt,
            threadId: source.threadId,
            turnId: source.turnId,
            generation: source.generation,
          },
    );
  },
);
it('keeps an unfinished preparation fenced after provider completion', () => {
  const f = fixture({ result: false });
  f.store.finish('conversation', binding, f.command.id, 'completed', 'turn');
  expect(f.store.completedPreparedRepositorySourceTarget('conversation', binding)).toBeUndefined();
  expect(f.store.read('conversation', binding).recovery).toBe(1);
  expect(() => f.store.acknowledgeRecovery('conversation', binding)).toThrow(/phase|effect/);
});
it('does not reuse an earlier preparation result for a later ordinary completed turn', () => {
  const f = fixture();
  f.store.finish('conversation', binding, f.command.id, 'completed', 'turn');
  f.store.enqueue('conversation', binding, { id: 'followup', prompt: 'Continue task' });
  const command = f.store.claimNext('conversation', binding)!;
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'binding',
    mode: 'agent',
    cwd: '/original',
    readableRoots: ['/selected'],
    writableRoots: ['/original'],
    deniedRoots: ['/credentials'],
  });
  f.store.prepareNativeExecution('conversation', binding, command, 'thread', policy);
  f.store.recordNativeTurnAck('conversation', binding, command, 'thread', 'later-turn');
  f.store.acceptNativeExecution('conversation', binding, command, 'thread', 'later-turn');
  f.store.finish('conversation', binding, command.id, 'completed', 'later-turn');
  expect(f.store.completedNativeTurnTarget('conversation', binding)).toMatchObject({
    commandId: 'followup',
  });
  expect(f.store.completedPreparedRepositorySourceTarget('conversation', binding)).toBeUndefined();
});

it('retains exact completed phase custody for cold owner creation without granting dispatch or projection', () => {
  const f = fixture();
  const phase = f.store.beginCompletionPhase(
    'conversation',
    binding,
    f.command,
    'thread',
    'turn',
    'f'.repeat(64),
  );
  f.store.finish('conversation', binding, f.command.id, 'completed', 'turn', true);
  expect(() =>
    f.store.assertPreparedRepositoryRecovery('conversation', binding, 'original'),
  ).not.toThrow();
  expect(() =>
    f.store.reconcilePreparedRepositoryWorkspaceProjection(
      'conversation',
      binding,
      source,
      '/original',
      '/prepared',
    ),
  ).toThrow(/unsettled/);
  expect(f.store.read('conversation', binding)).toMatchObject({ cwd: '/original', recovery: 1 });
  f.store.observeCompletionPhase('conversation', binding, phase.target, 'completed');
  expect(() => f.store.acknowledgeRecovery('conversation', binding)).toThrow(/phase|effect/);
  f.store.reconcileCompletionPhase('conversation', binding, phase.target, phase.workspaceDigest);
  // Original late success establishes effect evidence, never automatic release.
  expect(f.store.read('conversation', binding).recovery).toBe(1);
  expect(() =>
    f.store.assertPreparedRepositoryRecovery('conversation', binding, 'original'),
  ).not.toThrow();
  expect(() => f.store.acknowledgeRecovery('conversation', binding)).not.toThrow();
  expect(f.store.commandStatus('conversation', binding, 'original')).toBe('completed');
});
