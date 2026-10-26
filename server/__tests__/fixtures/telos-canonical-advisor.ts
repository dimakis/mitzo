import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../event-store.js';
import { TelosWorkStore } from '../../telos-work-store.js';
import { TelosArtifactStore } from '../../telos-artifact-store.js';
import { TelosWorkAdvisorDraft } from '../../telos-work-advisor-draft.js';
import { reviewTelosWorkRoleContext } from '../../telos-work-role-review.js';
import { retainTelosWorkRoleContext } from '../../telos-work-role-context.js';
import type { TelosWorkAdvisorDraftPreviewRequest } from '@mitzo/protocol';

export type CanonicalVariant = 'fresh' | 'upgraded';
/** Real accepted MGMT DDL, synthetic rows only; no test-only ALTER/default DB. */
export function createTelosCanonicalData(variant: CanonicalVariant = 'fresh') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-canonical-'));
  const dbPath = join(root, 'telos.db');
  const db = new Database(dbPath);
  // Match TodoStore's journal policy before constructing concurrent owners.
  // A first reader must not race another reader's DELETE-to-WAL conversion.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const directory = new URL('./telos-canonical-3077b7b4/', import.meta.url);
  const schema = readFileSync(new URL(`${variant}.sql`, directory), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
  if (
    manifest.owner.revision !== '3077b7b4dcdf0ef097062794b2ab93d33c1d89ad' ||
    createHash('sha256').update(schema).digest('hex') !== manifest.schemas[variant]
  )
    throw new Error('Canonical fixture does not match its accepted owner manifest');
  db.exec(schema);
  const stamp = '2026-10-16T10:00:00';
  db.prepare(
    `INSERT INTO items
    (id,summary,intent,rationale,acceptance_criteria,profile,priority,context_hints,
    first_seen,last_seen,created_at,updated_at)
    VALUES('studio','Home studio','Record music','Make music','["Approved plan"]',
    'manual',8,'{"people":["Original person"],"task_hint":"Original hint"}',?,?,?,?)`,
  ).run(stamp, stamp, stamp, stamp);
  db.prepare(
    `INSERT INTO history(item_id,old_status,new_status,changed_at)
    VALUES('studio',NULL,'active',?)`,
  ).run(stamp);
  let events = new EventStore(join(root, 'events.db'));
  let artifacts = new TelosArtifactStore(dbPath);
  let work = new TelosWorkStore(dbPath, { ordinaryConversation: (id) => id === 'planning' });
  const actor = { kind: 'operator' as const, id: 'canonical-offline-operator' };
  events.upsertSession({
    sessionId: 'planning',
    conversationSource: 'mitzo',
    summary: 'Studio planning',
  });
  const material = artifacts.save({
    itemId: 'studio',
    filename: 'acoustic-plan.md',
    title: 'Acoustic plan',
    bytes: Buffer.from('The reviewed panel layout.'),
    sessionId: 'planning',
  });
  const closeOwners = () => {
    work.close();
    artifacts.close();
    events.close();
  };
  return {
    dbPath,
    db,
    stamp,
    actor,
    material,
    get events() {
      return events;
    },
    get artifacts() {
      return artifacts;
    },
    get work() {
      return work;
    },
    restartOwners() {
      closeOwners();
      events = new EventStore(join(root, 'events.db'));
      artifacts = new TelosArtifactStore(dbPath);
      work = new TelosWorkStore(dbPath, { ordinaryConversation: (id) => id === 'planning' });
    },
    close() {
      closeOwners();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function createCanonicalAdvisorFixture(
  variant: CanonicalVariant,
  operation: 'refine' | 'child',
) {
  const base = createTelosCanonicalData(variant);
  const { work, events, artifacts, actor } = base;
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  events.upsertSession({
    sessionId: 'planning',
    conversationSource: 'mitzo',
    accountBinding: binding,
  });
  work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'kind',
      expectedRevision: work.read('studio', actor).revision,
      kind: 'outcome',
    },
    actor,
  );
  const context = reviewTelosWorkRoleContext({
    work,
    artifacts,
    actor,
    itemId: 'studio',
    role: 'advisor',
    advisorPurpose: operation,
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  retainTelosWorkRoleContext(events, 'planning', binding, context);
  work.execute(
    {
      operation: 'link',
      itemId: 'studio',
      requestId: 'advisor',
      expectedRevision: work.read('studio', actor).revision,
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    },
    actor,
  );
  const sequence = events.append('planning', 'user_message', {
    messageId: 'reviewed',
    text: 'Retain this reviewed plan; execution is a separate decision.',
  });
  const revision = work.read('studio', actor).revision;
  const input: TelosWorkAdvisorDraftPreviewRequest = {
    requestId: randomUUID(),
    operation,
    itemId: 'studio',
    advisorConversationId: 'planning',
    expectedRevision: revision,
    parentId: operation === 'child' ? 'studio' : null,
    expectedParentRevision: operation === 'child' ? revision : null,
    proposed: {
      name: 'Reviewed plan',
      desiredOutcome: 'Record clearly',
      type: operation === 'child' ? 'work_item' : 'outcome',
      category: 'Music',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning',
      mode: 'selected',
      boundary: { sequence, messageId: 'reviewed' },
      messageIds: ['reviewed'],
      artifacts: [],
      purpose: 'Retain reviewed plan',
      joiningBrief: '',
    },
  };
  const owner = () =>
    new TelosWorkAdvisorDraft({
      events: base.events,
      artifacts: base.artifacts,
      work: base.work,
      assertAuthorized: () => {},
      authorizeSource: () => true,
      authorizeArtifact: () => true,
    });
  return Object.assign(base, { input, owner });
}
