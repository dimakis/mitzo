import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexConversationStore } from '../codex-conversation-store.js';

const binding = {
  accountId: 'offline-one',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'test-model',
  profileRevision: 'revision',
};
const identity = {
  turnId: 'turn',
  toolName: 'DiscoverLocalRepository',
  requestHash: 'a'.repeat(64),
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(selected = binding) {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-store-statements-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'private.db');
  const seed = new CodexConversationStore(path);
  seed.create('chat', selected, '/offline');
  seed.bindThread('chat', selected, 'thread');
  seed.enqueue('chat', selected, { id: 'command', prompt: 'Offline fixture' });
  const command = seed.claimNext('chat', selected)!;
  seed.recordNativeTurnAck('chat', selected, command, 'thread', 'turn');
  seed.claimTool('chat', selected, 'command', 'call', identity);
  seed.close();
  const store = new CodexConversationStore(path);
  cleanup.push(() => {
    if ((store as unknown as { db: Database.Database }).db.open) store.close();
  });
  const writer = new Database(path);
  cleanup.push(() => writer.close());
  writer.prepare("UPDATE codex_conversations SET owner_kind='ordinary' WHERE id='chat'").run();
  return { path, store, writer, binding: selected };
}
function hotReads(f: ReturnType<typeof fixture>) {
  const { store, binding: selected } = f;
  expect(store.read('chat', selected).threadId).toBe('thread');
  expect(store.readHostCustody('chat', selected)).toBeNull();
  expect(store.readThreadAcceptances('chat', selected)).toEqual([]);
  expect(store.pendingThreadOwnership('chat', selected)).toBeUndefined();
  expect(store.nativeTurnTarget('chat', selected, 'command', 1)).toMatchObject({ turnId: 'turn' });
  expect(store.commandStatus('chat', selected, 'command')).toBe('running');
  expect(store.pendingNativeHostTool('chat', selected, 'call', identity)).toMatchObject({
    callId: 'call',
    turnId: 'turn',
  });
}

it('prepares only the six fixed hot statements once while executing every read freshly', () => {
  const f = fixture();
  const db = (f.store as unknown as { db: Database.Database }).db;
  const prepare = db.prepare.bind(db);
  const reads: Array<ReturnType<typeof vi.spyOn>> = [];
  const prepared = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    reads.push(vi.spyOn(statement, 'get'), vi.spyOn(statement, 'all'));
    return statement;
  });
  hotReads(f);
  const firstExecutions = reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  hotReads(f);
  expect(prepared).toHaveBeenCalledTimes(6);
  expect(new Set(prepared.mock.calls.map(([sql]) => sql)).size).toBe(6);
  expect(firstExecutions).toBe(22);
  expect(reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(44);
});

it('observes status, attempt, pending ownership and completed tool changes after warm reads', async () => {
  const f = fixture();
  hotReads(f);
  f.writer.prepare("UPDATE codex_commands SET status='completed' WHERE id='command'").run();
  expect(f.store.commandStatus('chat', binding, 'command')).toBe('completed');
  expect(f.store.nativeTurnTarget('chat', binding, 'command', 1)).toBeUndefined();
  expect(f.store.pendingNativeHostTool('chat', binding, 'call', identity)).toBeUndefined();
  f.writer.prepare("UPDATE codex_commands SET status='running',attempt=2 WHERE id='command'").run();
  expect(f.store.nativeTurnTarget('chat', binding, 'command', 1)).toBeUndefined();
  f.writer.prepare("UPDATE codex_commands SET attempt=1 WHERE id='command'").run();
  await Promise.resolve().then(() => {
    f.writer
      .prepare(
        `INSERT INTO codex_thread_acceptances
      (conversation_id,command_id,attempt,thread_id,turn_id,generation,ownership_pending,accepted_at)
      VALUES ('chat','command',1,'thread','turn',0,1,1)`,
      )
      .run();
  });
  expect(f.store.readThreadAcceptances('chat', binding)).toMatchObject([
    { ownershipPending: true },
  ]);
  expect(f.store.pendingThreadOwnership('chat', binding)).toMatchObject({ threadId: 'thread' });
  expect(f.store.nativeTurnTarget('chat', binding, 'command', 1)).toBeUndefined();
  f.writer.prepare('UPDATE codex_thread_acceptances SET terminal_conflict=1').run();
  expect(() => f.store.pendingThreadOwnership('chat', binding)).toThrow(/conflicting/);
  f.writer.prepare('DELETE FROM codex_thread_acceptances').run();
  expect(f.store.nativeTurnTarget('chat', binding, 'command', 1)).toMatchObject({ turnId: 'turn' });
  f.writer.prepare("UPDATE codex_tools SET result_content='done',result_is_error=0").run();
  expect(f.store.pendingNativeHostTool('chat', binding, 'call', identity)).toBeUndefined();
});

it('rechecks binding and custody schema after errors and across awaits without retaining a result', async () => {
  const f = fixture();
  hotReads(f);
  f.writer.prepare("UPDATE codex_conversations SET host_custody='{}'").run();
  expect(() => f.store.readHostCustody('chat', binding)).toThrow();
  f.writer.prepare('UPDATE codex_conversations SET host_custody=NULL').run();
  expect(f.store.readHostCustody('chat', binding)).toBeNull();
  await Promise.resolve().then(() => {
    f.writer.prepare("UPDATE codex_conversations SET binding='[]'").run();
  });
  for (const read of [
    () => f.store.read('chat', binding),
    () => f.store.readHostCustody('chat', binding),
    () => f.store.readThreadAcceptances('chat', binding),
    () => f.store.pendingThreadOwnership('chat', binding),
    () => f.store.nativeTurnTarget('chat', binding, 'command', 1),
    () => f.store.commandStatus('chat', binding, 'command'),
    () => f.store.pendingNativeHostTool('chat', binding, 'call', identity),
  ])
    expect(read).toThrow(/binding/);
});

it('retries a failed lazy preparation without retaining its error or a row', () => {
  const f = fixture();
  const db = (f.store as unknown as { db: Database.Database }).db;
  const original = db.prepare.bind(db);
  const error = Error('Offline preparation failure');
  const prepare = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
    throw error;
  });
  expect(() => f.store.read('chat', binding)).toThrow(error);
  prepare.mockImplementation(original);
  expect(f.store.read('chat', binding).threadId).toBe('thread');
  expect(prepare).toHaveBeenCalledTimes(2);
  f.writer.prepare("UPDATE codex_conversations SET thread_id='changed'").run();
  expect(f.store.read('chat', binding).threadId).toBe('changed');
  expect(prepare).toHaveBeenCalledTimes(2);
});

it('retains the second binding fence when a row changes between queries of one pending proof', () => {
  const f = fixture();
  const db = (f.store as unknown as { db: Database.Database }).db;
  const prepare = db.prepare.bind(db);
  let armed = false,
    changed = false;
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql);
    if (statement.source.includes('SELECT c.id AS conversationId')) {
      const get = statement.get;
      vi.spyOn(statement, 'get').mockImplementation(function (
        this: Database.Statement,
        ...args: unknown[]
      ) {
        const value = Reflect.apply(get, this, args);
        if (armed && !changed) {
          changed = true;
          prepare("UPDATE codex_conversations SET binding='[]'").run();
        }
        return value;
      });
    }
    return statement;
  });
  hotReads(f);
  // Every original conversation SELECT must still execute. Change its binding
  // after the first row is returned; the later nested read must refuse it even
  // inside the same synchronous transaction (not merely at the next API call).
  armed = true;
  expect(() => f.store.pendingNativeHostTool('chat', binding, 'call', identity)).toThrow(/binding/);
  expect(changed).toBe(true);
});

it('keeps statement ownership per database/account and refuses warm reads after close', () => {
  const first = fixture();
  const second = fixture({ ...binding, accountId: 'offline-two', provider: 'openai' });
  hotReads(first);
  hotReads(second);
  first.writer.prepare("UPDATE codex_commands SET status='failed'").run();
  expect(first.store.commandStatus('chat', binding, 'command')).toBe('failed');
  expect(second.store.commandStatus('chat', second.binding, 'command')).toBe('running');
  expect(() => second.store.read('chat', binding)).toThrow(/binding/);
  first.store.close();
  expect(() => first.store.read('chat', binding)).toThrow(/not open|closed/);
  const reopened = new CodexConversationStore(first.path);
  try {
    expect(reopened.commandStatus('chat', binding, 'command')).toBe('failed');
  } finally {
    reopened.close();
  }
});

it.runIf(process.env.MITZO_STORE_STATEMENT_BENCHMARK === '1')(
  'reports an offline repeated fresh-read component benchmark',
  () => {
    const f = fixture();
    const iterations = 2000;
    const run = () => {
      f.store.read('chat', binding);
      f.store.readHostCustody('chat', binding);
      f.store.readThreadAcceptances('chat', binding);
      f.store.pendingThreadOwnership('chat', binding);
      f.store.nativeTurnTarget('chat', binding, 'command', 1);
      f.store.commandStatus('chat', binding, 'command');
      f.store.pendingNativeHostTool('chat', binding, 'call', identity);
    };
    for (let i = 0; i < 100; i++) run();
    const elapsedMs: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const started = performance.now();
      for (let i = 0; i < iterations; i++) run();
      elapsedMs.push(Number((performance.now() - started).toFixed(3)));
    }
    console.info(
      'Offline native store fresh-read benchmark',
      JSON.stringify({ iterations, elapsedMs }),
    );
    hotReads(f);
  },
);
