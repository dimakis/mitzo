import { createHash } from 'node:crypto';
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
  toolName: 'PrepareLocalRepository',
  requestHash: 'a'.repeat(64),
  resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
};
const cleanups: Array<() => void> = [];
it('hashes the actual retained public result, excluding private executor fields', () => {
  expect(preparedRepositoryResultSha256({ ...result, environmentRefresh: true })).toBe(
    source.resultSha256,
  );
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
      }),
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
