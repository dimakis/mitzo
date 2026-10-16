import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  buildPermissionHandler,
  SessionRegistry,
  resolvePending,
  getPendingRequestsBySession,
} from '@mitzo/harness';
import type { TelosOutcomeCreation, TelosSourcePermissionReceipt } from '@mitzo/protocol';
import { EventStore } from '../../event-store.js';
import { TelosArtifactStore } from '../../telos-artifact-store.js';
import { TelosWorkStore } from '../../telos-work-store.js';
import { TelosSourceApproval } from '../../telos-source-approval.js';
import { TelosSourceApprovalStore } from '../../telos-source-approval-store.js';
import { formatTelosSourceResult, type TelosToolResult } from '../../telos-tool.js';
import { createTelosSourcePermissionRecovery } from '../../telos-source-recovery.js';

/** Real temporary owners and the actual harness permission handler. Only the
 * external canonical creation port is injected, writing this temporary database.
 * No provider, scheduler, ordinary allocator or application server is started. */
export function createTelosSourceApprovalData() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-approval-browser-'));
  const dbPath = join(root, 'telos.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,profile TEXT,status TEXT,starred INTEGER,context_hints TEXT,created_at TEXT,updated_at TEXT,idempotency_key TEXT UNIQUE);
    INSERT INTO items VALUES('studio',NULL,'Home studio','Record clearly','Make music','["Acoustic plan approved"]','personal','active',0,'{}','2026-10-16','original',NULL);
    CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,source_id TEXT,url TEXT,title TEXT,author TEXT,timestamp TEXT,raw_snippet TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  let events = new EventStore(join(root, 'events.db'));
  let artifacts = new TelosArtifactStore(dbPath);
  let work = new TelosWorkStore(dbPath, { ordinaryConversation: (id) => id === 'planning' });
  let store = new TelosSourceApprovalStore(dbPath);
  const registry = new SessionRegistry();
  const actor = { kind: 'operator' as const, id: 'explicit-offline-fixture-operator' };
  const queued: Record<string, unknown>[] = [];
  let requestArrived: ((event: Record<string, unknown>) => void) | undefined;
  const controller = new AbortController();
  registry.register('offline-client', {
    transport: {
      isOpen: () => true,
      send: (event) => {
        queued.push(event);
        if (event.type === 'permission_request') requestArrived?.(event);
      },
    },
    abortController: controller,
    sessionId: 'planning',
    sessionAllowList: new Set(),
    mode: 'agent',
  });
  events.upsertSession({
    sessionId: 'planning',
    conversationSource: 'mitzo',
    summary: 'Studio planning',
  });
  const messages = [
    { messageId: 'before', text: 'Earlier discussion that was not selected.' },
    { messageId: 'approved', text: 'Use the approved acoustic plan.' },
    { messageId: 'after', text: 'Later discussion that was not selected.' },
  ].map(({ messageId, text }) => {
    events.append('planning', 'user_message', { messageId, text });
    return {
      messageId,
      role: 'user' as const,
      blocks: [{ blockId: `user-${messageId}`, blockType: 'text' as const, content: text }],
    };
  });
  const material = artifacts.save({
    itemId: 'studio',
    filename: 'acoustic-plan.md',
    title: 'Acoustic plan',
    bytes: Buffer.from('The reviewed panel layout.'),
    sessionId: 'planning',
  });
  let canonicalCreates = 0;
  let loseCanonicalResponse = false;
  const canonicalReply = (itemId: string, created: boolean, summary: string) => {
    if (loseCanonicalResponse) {
      loseCanonicalResponse = false;
      throw Error('Offline fixture lost canonical creation response after the write');
    }
    return {
      itemId,
      receipt: {
        ok: true,
        created,
        item: { id: itemId, summary },
        delivery: { state: 'retained' },
      },
    };
  };
  const createOutcome = async (body: TelosOutcomeCreation) => {
    const prior = db
      .prepare('SELECT id,summary FROM items WHERE idempotency_key=?')
      .get(body.idempotencyKey) as { id: string; summary: string } | undefined;
    if (prior) return canonicalReply(prior.id, false, prior.summary);
    const id = 'created-' + ++canonicalCreates;
    const hints = body.contextHints ?? {};
    db.prepare(
      "INSERT INTO items VALUES(?,NULL,?,?,?,?,?,'active',0,?,'2026-10-16','2026-10-16',?)",
    ).run(
      id,
      body.summary,
      body.intent,
      body.rationale,
      JSON.stringify(body.acceptanceCriteria),
      body.profile,
      JSON.stringify({
        ...hints,
        doc_ids: hints.docIds ?? [],
        jira_keys: hints.jiraKeys ?? [],
        task_hint: hints.taskHint ?? '',
        session_ids: hints.sessionIds ?? [],
      }),
      body.idempotencyKey,
    );
    for (const [index, link] of (body.links ?? []).entries())
      db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?,?)').run(
        id + '-link-' + index,
        id,
        link.type,
        link.url.trim(),
        link.title,
        link.description ?? '',
        '2026-10-16',
      );
    for (const [index, title] of body.milestones.entries())
      db.prepare(
        "INSERT INTO items VALUES(?,?,?,'','','[]',?,'active',0,'{}','2026-10-16','2026-10-16',NULL)",
      ).run(id + '-slice-' + index, id, title, body.profile);
    return canonicalReply(id, true, body.summary);
  };
  let service = new TelosSourceApproval({ events, artifacts, work, store, createOutcome });
  const recovery = createTelosSourcePermissionRecovery(() => dbPath);
  const handler = buildPermissionHandler('offline-client', registry);
  let settlement: Promise<void> = Promise.resolve();
  let executed: ReturnType<TelosSourceApproval['execute']> | null = null;
  let toolResult: TelosToolResult | null = null;
  let denials = 0;
  let activePermission: string | null = null;

  return {
    dbPath,
    createOutcome,
    registry,
    get service() {
      return service;
    },
    get events() {
      return events;
    },
    get artifacts() {
      return artifacts;
    },
    get work() {
      return work;
    },
    material,
    actor,
    messages,
    async request(input: { kind: 'create' | 'adopt'; marker: 'native' | 'sdk'; itemId?: string }) {
      executed = null;
      toolResult = null;
      const proposal =
        input.kind === 'adopt'
          ? { itemId: input.itemId ?? 'studio' }
          : {
              summary: 'Studio acoustic treatment',
              intent: 'Record clearly',
              rationale: 'Make music',
              acceptanceCriteria: ['Acoustic plan approved'],
              profile: 'personal',
              milestones: ['Install reviewed panels'],
            };
      const toolName =
        (input.marker === 'sdk' ? 'mcp__telos__' : '') +
        (input.kind === 'create' ? 'TelosCreateOutcome' : 'TelosAdoptSource');
      const arrival = new Promise<Record<string, unknown>>((resolve) => {
        requestArrived = resolve;
      });
      settlement = handler(toolName, proposal, {
        signal: controller.signal,
        toolUseID: randomUUID(),
      }).then((resolution) => {
        if (resolution.behavior === 'deny') {
          denials++;
          return;
        }
        const approval = resolution.updatedInput?.__mitzoTelosApproval;
        if (typeof approval !== 'string') throw Error('Actual source approval receipt missing');
        executed = service.execute(approval, 'planning', proposal);
        toolResult = formatTelosSourceResult(executed);
      });
      const event = await arrival;
      activePermission = String(event.permId);
      return event;
    },
    async respond(input: { permId: string; decision: 'deny'; sessionId: string }) {
      if (!resolvePending(input.permId, input.decision, undefined, input.sessionId)) {
        if (!recovery.dismiss(input.permId, input.sessionId, actor.id))
          throw Error('Permission response refused');
        queued.push({
          type: 'permission_resolved',
          permId: input.permId,
          sessionId: input.sessionId,
        });
      }
      await settlement;
    },
    loseNextSaveResponse() {
      const actual = service.capture.createReviewed.bind(service.capture);
      service.capture.createReviewed = async (...args) => {
        await actual(...args);
        throw Error('Offline fixture lost completed source save response');
      };
    },
    loseNextCanonicalResponse() {
      loseCanonicalResponse = true;
    },
    restartOwners() {
      controller.abort();
      registry.dispose();
      store.close();
      work.close();
      artifacts.close();
      events.close();
      events = new EventStore(join(root, 'events.db'));
      artifacts = new TelosArtifactStore(dbPath);
      work = new TelosWorkStore(dbPath, { ordinaryConversation: (id) => id === 'planning' });
      store = new TelosSourceApprovalStore(dbPath);
      service = new TelosSourceApproval({ events, artifacts, work, store, createOutcome });
    },
    recoveryRequests() {
      return recovery.list('planning', actor.id);
    },
    pendingRequests() {
      const live = getPendingRequestsBySession('planning');
      return [
        ...live,
        ...recovery
          .list('planning', actor.id)
          .filter((request) => !live.some((pending) => pending.permId === request.permId)),
      ];
    },
    hideOriginalSource() {
      events.hideSession('planning');
      return events.getSession('planning')?.isHidden === true;
    },
    async settled() {
      await settlement;
      return executed;
    },
    toolResult() {
      return toolResult;
    },
    drainEvents() {
      return queued.splice(0);
    },
    staleItem(itemId = 'studio') {
      db.prepare('UPDATE items SET rationale=?,updated_at=? WHERE id=?').run(
        'Changed after review',
        'changed',
        itemId,
      );
    },
    advanceMaterial() {
      return artifacts.save({
        itemId: 'studio',
        filename: material.filename,
        title: material.title,
        bytes: Buffer.from('A newer unreviewed panel layout.'),
        sessionId: 'planning',
      });
    },
    counts() {
      return {
        canonicalCreates,
        denials,
        allocations: registry.get('offline-client')?.activeTaskIds.size ?? 0,
        originSessions: [...registry.entries()].map(([, session]) => session.sessionId),
        sources: db.prepare('SELECT COUNT(*) AS total FROM telos_work_sources').get() as {
          total: number;
        },
      };
    },
    receiptSource(receipt: TelosSourcePermissionReceipt) {
      return service.capture.read(receipt.receipt.work.itemId, receipt.sourceSnapshotId, actor);
    },
    todos() {
      const rows = db.prepare('SELECT * FROM items WHERE parent_id IS NULL ORDER BY id').all() as {
        id: string;
        summary: string;
        intent: string;
        rationale: string;
        acceptance_criteria: string;
        profile: string;
      }[];
      return {
        profiles: ['personal'],
        items: rows.map((row) => ({
          id: row.id,
          summary: row.summary,
          intent: row.intent,
          rationale: row.rationale,
          acceptanceCriteria: JSON.parse(row.acceptance_criteria),
          profile: row.profile,
          status: 'active',
          starred: false,
          urgency: 0,
          ageDays: 0,
          parentId: null,
          children: [],
          childCount: 0,
          completedChildCount: 0,
          sources: [],
          goalId: null,
          contextHints: {
            repos: [],
            paths: [],
            issues: [],
            docIds: [],
            people: [],
            jiraKeys: [],
            keywords: [],
            taskHint: '',
          },
        })),
      };
    },
    close() {
      if (activePermission) resolvePending(activePermission, 'deny', undefined, 'planning');
      controller.abort();
      registry.dispose();
      store.close();
      work.close();
      artifacts.close();
      events.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
