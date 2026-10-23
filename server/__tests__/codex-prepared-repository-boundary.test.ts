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
