import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../src/event-store.js';

const closes: Array<() => void> = [];
afterEach(() =>
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-event-reference-'));
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  closes.push(() => store.close());
  expect(typeof store.assertNoRetainedTelosWorkReferences).toBe('function');
  return { store, path };
}
function payload(sessionId = 'retained-role') {
  const text = 'Reviewed brief';
  return {
    version: 1,
    sessionId,
    binding: {
      accountId: 'offline-fixture',
      provider: 'openai-codex',
      model: 'offline-fixture-only',
      profileRevision: 'fixture-v1',
    },
    selection: {
      version: 1,
      itemId: 'selected-outcome',
      role: 'lead',
      brief: {
        revision: 'brief-v1',
        sha256: createHash('sha256').update(text).digest('hex'),
        text,
      },
      parentCriteria: [{ itemId: 'parent-outcome', revision: 'parent-v1', criteria: [] }],
      overallGoal: { itemId: 'root-outcome', revision: 'root-v1', text: 'Goal' },
      sources: [],
      artifacts: [],
    },
    guidance: 'Retained ordinary role guidance',
  };
}

it('allows an unrelated ID without exposing retained conversation contents', () => {
  const { store } = fixture();
  store.append('retained-role', 'telos_work_role_context', payload());
  store.append('other', 'message_start', { text: 'unreferenced-leaf' });
  expect(store.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toBeUndefined();
});

it.each(['selected-outcome', 'parent-outcome', 'root-outcome'])(
  'denies retained role references to %s, including absent session metadata',
  (itemId) => {
    const { store } = fixture();
    store.append('retained-role', 'telos_work_role_context', payload());
    expect(() => store.assertNoRetainedTelosWorkReferences(itemId)).toThrow(/retained.*reference/i);
  },
);

it('keeps hidden, inactive roles as references and reads beyond bounded history APIs', () => {
  const { store } = fixture();
  store.upsertSession({ sessionId: 'retained-role', conversationSource: 'mitzo' });
  store.append('retained-role', 'telos_work_role_context', payload());
  for (let i = 0; i < 1025; i++) {
    const later = payload(`other-${i}`);
    later.selection.itemId = `unrelated-${i}`;
    later.selection.parentCriteria = [];
    later.selection.overallGoal.itemId = 'other-root';
    store.append(later.sessionId, 'telos_work_role_context', later);
  }
  store.markSessionInactive('retained-role');
  store.hideSession('retained-role');
  expect(store.listSessions().some((session) => session.sessionId === 'retained-role')).toBe(false);
  expect(() => store.assertNoRetainedTelosWorkReferences('selected-outcome')).toThrow(/reference/i);
});

it('decodes escaped item references and retains references in guidance', () => {
  const { store, path } = fixture();
  const raw = new Database(path);
  closes.push(() => raw.close());
  const data = payload();
  data.selection.itemId = 'quoted-"-\\-leaf';
  data.guidance = 'Previously selected source leaf-guidance-reference';
  raw
    .prepare('INSERT INTO events(session_id,type,payload) VALUES(?,?,?)')
    .run(
      data.sessionId,
      'telos_work_role_context',
      JSON.stringify(data).replace('parent-outcome', '\\u0070arent-outcome'),
    );
  for (const itemId of ['quoted-"-\\-leaf', 'parent-outcome', 'leaf-guidance-reference'])
    expect(() => store.assertNoRetainedTelosWorkReferences(itemId)).toThrow(/reference/i);
});

it.each(['direct', 'source'] as const)(
  'retains %s artifact references in the actual role selection',
  (placement) => {
    const { store } = fixture();
    const data = payload();
    const artifact = { artifactId: 'a'.repeat(32), revision: 1, sha256: 'b'.repeat(64) };
    const sources =
      placement === 'source'
        ? [
            {
              version: 1,
              snapshotId: 'retained-source',
              itemId: data.selection.itemId,
              source: null,
              selection: { kind: 'unknown' },
              adoptedBrief: null,
              artifacts: [artifact],
              author: null,
              sourceCreatedAt: null,
              adoptedAt: null,
            },
          ]
        : [];
    store.append('retained-role', 'telos_work_role_context', {
      ...data,
      selection: {
        ...data.selection,
        sources,
        artifacts: placement === 'direct' ? [artifact] : [],
      },
    });
    expect(() => store.assertNoRetainedTelosWorkReferences(artifact.artifactId)).toThrow(
      /retained.*reference/i,
    );
  },
);

it.each([
  'invalid-json-shape',
  'invalid-selection',
  'wrong-session',
  'unknown-payload-field',
  'changed-brief',
])('refuses to infer absence from %s role custody', (mode) => {
  const { store, path } = fixture();
  const raw = new Database(path);
  closes.push(() => raw.close());
  const data: Record<string, unknown> = payload();
  if (mode === 'invalid-selection') data.selection = { itemId: 'some-other-item' };
  if (mode === 'wrong-session') data.sessionId = 'different-role';
  if (mode === 'unknown-payload-field') data.unknownFutureReference = 'unknown';
  if (mode === 'changed-brief')
    (data.selection as ReturnType<typeof payload>['selection']).brief.text =
      'Changed retained bytes';
  raw.prepare('INSERT INTO events(session_id,type,payload) VALUES(?,?,?)').run(
    // The actual schema's JSON expression index already rejects malformed raw
    // JSON. A retained JSON null still has invalid role custody and must deny.
    'retained-role',
    'telos_work_role_context',
    mode === 'invalid-json-shape' ? 'null' : JSON.stringify(data),
  );
  expect(() => store.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toThrow(
    /unavailable/i,
  );
});

it('refuses conflicting retained selections for the same original role owner', () => {
  const { store } = fixture();
  store.append('retained-role', 'telos_work_role_context', payload());
  const changed = payload();
  changed.selection.itemId = 'different-outcome';
  store.append('retained-role', 'telos_work_role_context', changed);
  expect(() => store.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toThrow(
    /unavailable/i,
  );
});

it('retains references after the original owner restarts', () => {
  const { store, path } = fixture();
  store.append('retained-role', 'telos_work_role_context', payload());
  store.close();
  const restarted = new EventStore(path);
  closes.push(() => restarted.close());
  expect(() => restarted.assertNoRetainedTelosWorkReferences('selected-outcome')).toThrow(
    /reference/i,
  );
  expect(restarted.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toBeUndefined();
});

it('refuses a closed owner and a borrowed transaction that could hide new references', () => {
  const { store } = fixture();
  // Test-only inspection of the actual original owner, not a product DB getter.
  const db = (store as unknown as { db: Database.Database }).db;
  db.exec('BEGIN');
  expect(() => store.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toThrow(
    /unavailable/i,
  );
  db.exec('ROLLBACK');
  store.close();
  expect(() => store.assertNoRetainedTelosWorkReferences('unreferenced-leaf')).toThrow(
    /unavailable/i,
  );
});
