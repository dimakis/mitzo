import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { EventStore } from '../event-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { TaskStore } from '../task-store.js';
import { captureMitzoTelosCore } from '../backup/mitzo-telos.js';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
const actor = { kind: 'operator' as const, id: 'authenticated-user' };
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'telos-capture-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'telos.db');
  const db = new Database(dbPath);
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,profile TEXT,status TEXT,starred INTEGER,context_hints TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO items VALUES('item',NULL,'Studio','A working studio','Record music','["Plan approved"]','personal','active',1,'{}','2025-01-01','original');
    INSERT INTO items SELECT 'other',parent_id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at FROM items;
    CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,source_id TEXT,url TEXT,title TEXT,author TEXT,timestamp TEXT,raw_snippet TEXT);
    CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);`);
  db.exec(
    'ALTER TABLE items ADD COLUMN idempotency_key TEXT; CREATE UNIQUE INDEX creation_identity ON items(idempotency_key)',
  );
  const events = new EventStore(join(root, 'events.db'));
  const artifacts = new TelosArtifactStore(dbPath);
  const work = new TelosWorkStore(dbPath, {
    ordinaryConversation: (id) => id === 'origin' && !events.getSession(id)?.isHidden,
  });
  cleanups.push(() => {
    work.close();
    artifacts.close();
    events.close();
  });
  events.upsertSession({
    sessionId: 'origin',
    conversationSource: 'mitzo',
    summary: 'Planning the studio',
  });
  events.append('origin', 'user_message', {
    messageId: 'request',
    text: 'Plan my studio.',
    private: 'PRIVATE MUST NOT BE RETAINED',
  });
  const sequence = events.append('origin', 'user_message', {
    messageId: 'approved',
    text: 'Use the approved acoustic plan.',
  });
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'origin',
    mode: 'selected' as const,
    boundary: { sequence, messageId: 'approved' },
    messageIds: ['request', 'approved'],
    artifacts: [] as { artifactId: string; revision: number; sha256: string }[],
    purpose: 'Save the agreed outcome',
    joiningBrief: '',
  };
  let permitted = true;
  const options = {
    events,
    artifacts,
    work,
    authorizeSource: () => permitted,
    authorizeArtifact: () => permitted,
  };
  const capture = new TelosSourceCapture(options);
  const preview = (itemId = 'item') => capture.preview({ itemId, selection }, actor);
  let allocations = 0;
  const createOutcome = vi.fn(
    async (body: {
      idempotencyKey: string;
      summary: string;
      intent: string;
      rationale: string;
      acceptanceCriteria: string[];
      profile: string;
      milestones: string[];
      contextHints?: Record<string, unknown>;
      links?: { type: string; url: string; title: string; description?: string }[];
    }) => {
      const prior = db
        .prepare('SELECT id FROM items WHERE idempotency_key=?')
        .get(body.idempotencyKey) as { id: string } | undefined;
      if (prior) return { itemId: prior.id };
      const id = 'created-' + ++allocations;
      const hints = body.contextHints ?? {};
      const storedHints = {
        ...hints,
        doc_ids: hints.docIds ?? [],
        jira_keys: hints.jiraKeys ?? [],
        task_hint: hints.taskHint ?? '',
        session_ids: hints.sessionIds ?? [],
      };
      db.prepare(
        "INSERT INTO items VALUES(?,NULL,?,?,?,?,?,'active',1,?,'created','created',?)",
      ).run(
        id,
        body.summary,
        body.intent,
        body.rationale,
        JSON.stringify(body.acceptanceCriteria),
        body.profile,
        JSON.stringify(storedHints),
        body.idempotencyKey,
      );
      body.links?.forEach((link, i) =>
        db
          .prepare('INSERT INTO links VALUES(?,?,?,?,?,?,?)')
          .run(
            id + '-link-' + i,
            id,
            link.type,
            link.url.trim(),
            link.title,
            link.description ?? '',
            'created',
          ),
      );
      body.milestones.forEach((title, i) =>
        db
          .prepare(
            "INSERT INTO items VALUES(?,?,?,'','','[]',?,'active',1,'{}','created','created',NULL)",
          )
          .run(id + '-slice-' + i, id, title, body.profile),
      );
      return { itemId: id };
    },
  );
  return {
    root,
    db,
    dbPath,
    events,
    artifacts,
    work,
    capture,
    options,
    selection,
    preview,
    createOutcome,
    revoke: () => {
      permitted = false;
    },
  };
}

describe('reviewed Telos source capture through existing owners', () => {
  it('round trips reviewed canonical links and rejects duplicate references before creating anything', async () => {
    const f = fixture();
    const link = {
      type: 'design_doc',
      url: 'https://example.test/plan',
      title: 'Approved plan',
      description: 'Exact context',
    };
    const proposal = {
      requestId: 'links-roundtrip',
      outcome: {
        summary: 'Studio',
        intent: 'Record',
        rationale: 'Music',
        acceptanceCriteria: ['Ready'],
        profile: 'personal',
        milestones: ['Plan'],
        links: [link],
      },
      selection: f.selection,
    };
    await expect(
      f.capture.previewNew(
        { ...proposal, outcome: { ...proposal.outcome, links: [link, link] } },
        actor,
      ),
    ).rejects.toThrow(/distinct/);
    expect(f.createOutcome).not.toHaveBeenCalled();
    const preview = await f.capture.previewNew(proposal, actor);
    const receipt = await f.capture.createReviewed(
      { ...proposal, previewSha256: preview.sha256 },
      actor,
      f.createOutcome,
    );
    expect(f.work.readRecord(receipt.work.itemId, actor).links).toEqual([
      { ...link, addedAt: 'created' },
    ]);
    expect(
      f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, actor).packet.creation
        ?.outcome.links,
    ).toEqual([link]);
  });

  it('retains canonical links and refuses a creator that loses a reviewed link', async () => {
    const f = fixture();
    const outcome = {
      summary: 'Studio',
      intent: 'Record',
      rationale: 'Music',
      acceptanceCriteria: ['Ready'],
      profile: 'personal',
      milestones: ['Plan'],
      links: [
        {
          type: 'design_doc',
          url: 'https://example.test/plan',
          title: 'Approved plan',
          description: 'Pinned context',
        },
      ],
    };
    const proposal = { requestId: 'linked-plan', outcome, selection: f.selection };
    const preview = await f.capture.previewNew(proposal, actor);
    const dropLinks = async (body: Parameters<typeof f.createOutcome>[0]) => {
      const result = await f.createOutcome(body);
      f.db.prepare('DELETE FROM links WHERE item_id=?').run(result.itemId);
      return result;
    };
    await expect(
      f.capture.createReviewed({ ...proposal, previewSha256: preview.sha256 }, actor, dropLinks),
    ).rejects.toThrow(/reviewed/);
    expect(f.work.read('created-1', actor).sources).toEqual([]);
  });

  it('retains the actual boundary attribution even when the reviewed excerpt selects an earlier message', async () => {
    const f = fixture();
    const preview = await f.capture.preview(
      { itemId: 'item', selection: { ...f.selection, messageIds: ['request'] } },
      actor,
    );
    expect(preview.packet.context.messages.map((m) => m.messageId)).toEqual(['request']);
    expect(preview.packet.attributions.approved).toEqual({
      seatId: null,
      provenance: null,
      createdAt: expect.any(Number),
    });
  });

  it('restores source-only creation bytes, original boundary and completed recovery receipt through the existing backup owner', async () => {
    const f = fixture();
    const proposal = {
      requestId: 'backup-create',
      outcome: {
        summary: 'Studio',
        intent: 'Record',
        rationale: 'Music',
        acceptanceCriteria: ['Ready'],
        profile: 'personal',
        milestones: ['Acoustics'],
      },
      selection: f.selection,
    };
    const preview = await f.capture.previewNew(proposal, actor);
    const input = { ...proposal, previewSha256: preview.sha256 };
    const receipt = await f.capture.createReviewed(input, actor, f.createOutcome);
    const original = f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, actor);
    const tasks = new TaskStore(join(f.root, 'tasks.db'));
    try {
      const destination = join(f.root, 'backup');
      await captureMitzoTelosCore({
        owners: { events: f.events, telos: f.artifacts, tasks },
        destination,
      });
      const events = new EventStore(join(destination, 'mitzo-events', 'store.db'));
      const artifacts = new TelosArtifactStore(join(destination, 'telos', 'store.db'));
      const work = new TelosWorkStore(join(destination, 'telos', 'store.db'), {
        ordinaryConversation: (id) => !!events.getSession(id),
      });
      try {
        const capture = new TelosSourceCapture({
          events,
          artifacts,
          work,
          authorizeSource: () => true,
          authorizeArtifact: () => true,
        });
        expect(
          capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, actor),
        ).toEqual(original);
        const mustNotCreate = vi.fn(async () => {
          throw Error('must recover');
        });
        expect(await capture.createReviewed(input, actor, mustNotCreate)).toEqual(receipt);
        expect(mustNotCreate).not.toHaveBeenCalled();
        expect(work.read(receipt.work.itemId, actor)).toEqual(receipt.work);
        expect(events.getSession('origin')).toEqual(f.events.getSession('origin'));
      } finally {
        work.close();
        artifacts.close();
        events.close();
      }
    } finally {
      tasks.close();
    }
  });

  it('reviews a new outcome before creation and saves one source-only outcome through the canonical creator', async () => {
    const f = fixture();
    const outcome = {
      summary: 'Home studio',
      intent: 'Record clearly',
      rationale: 'Make music',
      acceptanceCriteria: ['Recording approved'],
      profile: 'personal',
      milestones: ['Plan acoustics'],
    };
    const proposal = { requestId: 'save-from-chat', outcome, selection: f.selection };
    const preview = await f.capture.previewNew(proposal, actor);
    expect(preview.packet.itemId).toBeNull();
    expect(f.createOutcome).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
    const input = { ...proposal, previewSha256: preview.sha256 };
    const receipt = await f.capture.createReviewed(input, actor, f.createOutcome);
    expect(receipt.work).toMatchObject({
      itemId: 'created-1',
      kind: 'outcome',
      assignments: [],
      attempts: [],
      links: [{ role: 'origin' }],
    });
    expect(f.work.read('created-1-slice-0', actor).kind).toBe('work_item');
    const view = f.capture.read(receipt.work.itemId, receipt.work.sources[0].snapshotId, actor);
    expect(view.packet).toEqual(preview.packet);
    expect(f.createOutcome).toHaveBeenCalledTimes(1);
    expect(f.createOutcome.mock.calls[0][0].contextHints).toMatchObject({ sessionIds: ['origin'] });
    expect(await f.capture.createReviewed(input, actor, f.createOutcome)).toEqual(receipt);
    expect(f.createOutcome).toHaveBeenCalledTimes(1);
    expect(f.events.listSessions()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM telos_work_allocation_outbox').all()).toEqual([]);
  });

  it('recovers canonical creation after losing its response before recording the item identity', async () => {
    const f = fixture();
    const proposal = {
      requestId: 'crash-during-save',
      selection: f.selection,
      outcome: {
        summary: 'Reviewed feature',
        intent: 'Ship it',
        rationale: 'Why',
        acceptanceCriteria: ['Verified'],
        profile: 'mitzo',
        milestones: ['Slice one'],
      },
    };
    const preview = await f.capture.previewNew(proposal, actor);
    const input = { ...proposal, previewSha256: preview.sha256 };
    const record = vi.spyOn(f.work, 'recordSourceCreationItem').mockImplementationOnce(() => {
      throw Error('Lost creation response');
    });
    await expect(f.capture.createReviewed(input, actor, f.createOutcome)).rejects.toThrow(
      /Lost creation response/,
    );
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM items WHERE idempotency_key IS NOT NULL').get(),
    ).toEqual({ n: 1 });
    record.mockRestore();
    f.events.append('origin', 'user_message', {
      messageId: 'after-create',
      text: 'Keep this later turn out',
    });
    const receipt = await new TelosSourceCapture(f.options).createReviewed(
      input,
      actor,
      f.createOutcome,
    );
    expect(receipt.work.itemId).toBe('created-1');
    expect(f.createOutcome.mock.calls[0][0].idempotencyKey).toBe(
      f.createOutcome.mock.calls[1][0].idempotencyKey,
    );
    expect(f.capture.read('created-1', receipt.work.sources[0].snapshotId, actor).packet).toEqual(
      preview.packet,
    );
    await expect(
      f.capture.createReviewed(
        { ...input, outcome: { ...proposal.outcome, intent: 'Different intent' } },
        actor,
        f.createOutcome,
      ),
    ).rejects.toThrow();
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM items WHERE idempotency_key IS NOT NULL').get(),
    ).toEqual({ n: 1 });
  });

  it('creates nothing for an unreviewed or no-longer-authorized new outcome', async () => {
    const f = fixture();
    const proposal = {
      requestId: 'not-approved',
      selection: f.selection,
      outcome: {
        summary: 'Outcome',
        intent: 'Result',
        rationale: 'Why',
        acceptanceCriteria: ['Evidence'],
        profile: 'manual',
        milestones: ['One'],
      },
    };
    await expect(
      f.capture.createReviewed(
        { ...proposal, previewSha256: '0'.repeat(64) },
        actor,
        f.createOutcome,
      ),
    ).rejects.toThrow();
    const preview = await f.capture.previewNew(proposal, actor);
    f.revoke();
    await expect(
      f.capture.createReviewed(
        { ...proposal, previewSha256: preview.sha256 },
        actor,
        f.createOutcome,
      ),
    ).rejects.toThrow();
    expect(f.createOutcome).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 2 });
  });

  it('retains a valid large canonical proposal without inventing a recipient joining brief or truncating the outcome', async () => {
    const f = fixture();
    const outcome = {
      summary: 'Large outcome',
      intent: 'i'.repeat(2000),
      rationale: 'r'.repeat(2000),
      acceptanceCriteria: Array.from({ length: 12 }, () => 'a'.repeat(500)),
      profile: 'manual',
      milestones: Array.from({ length: 24 }, () => 'm'.repeat(500)),
    };
    const preview = await f.capture.previewNew(
      { requestId: 'large-proposal', outcome, selection: f.selection },
      actor,
    );
    expect(preview.packet.brief.text.length).toBeGreaterThan(20000);
    expect(JSON.parse(preview.packet.brief.text)).toMatchObject(outcome);
    expect(preview.packet.context.joiningBrief).toBe('');
    expect(f.createOutcome).not.toHaveBeenCalled();
  });
  it('pins capture, wire contracts and the touched artifact/work owners in the reviewed manifest', () => {
    const manifest: Record<string, string> = reviewedHandlerSourceArtifacts;
    for (const file of [
      '../telos-source-capture.ts',
      '../telos-artifact-store.ts',
      '../telos-work-store.ts',
      '../../packages/protocol/src/telos-source.ts',
      '../../packages/protocol/src/index.ts',
    ])
      expect(manifest[file], file).toBe(
        reviewedHandlerSourceFingerprint(
          readFileSync(new URL(file, new URL('../connections/', import.meta.url)), 'utf8'),
        ),
      );
  });
  it('previews the actual public exchange and canonical brief without assigning a lead or writing any artifact/link', async () => {
    const f = fixture();
    const before = f.work.read('item', actor);
    const result = await f.preview();
    expect(result.sha256).toBe(
      createHash('sha256').update(JSON.stringify(result.packet)).digest('hex'),
    );
    expect(result.packet.context.messages.map((message) => message.messageId)).toEqual([
      'request',
      'approved',
    ]);
    expect(result.packet.context.capacity.status).toBe('unverified');
    expect(JSON.parse(result.packet.brief.text)).toMatchObject({
      summary: 'Studio',
      intent: 'A working studio',
      rationale: 'Record music',
      acceptanceCriteria: ['Plan approved'],
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(f.work.read('item', actor)).toEqual(before);
    expect(f.artifacts.list({ itemId: 'item' })).toEqual([]);
    expect(f.events.listSessions()).toHaveLength(1);
    expect(f.events.getSession('origin')?.selectedModel).toBeNull();
  });

  it('retains exact source bytes, the adopted brief and a real origin backlink without executing work', async () => {
    const f = fixture();
    const preview = await f.preview();
    const input = {
      itemId: 'item',
      requestId: 'adopt',
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
      selection: f.selection,
    };
    const receipt = await f.capture.adopt(input, actor);
    const snapshot = receipt.work.sources[0];
    expect(snapshot.source).toEqual({ namespace: 'mitzo', conversationId: 'origin' });
    expect(snapshot.selection).toEqual({
      kind: 'selected',
      messageIds: ['request', 'approved'],
      blockIds: [],
      throughSequence: f.selection.boundary.sequence,
    });
    expect(snapshot.adoptedBrief).toEqual({
      revision: preview.packet.brief.sha256,
      sha256: preview.packet.brief.sha256,
    });
    expect(receipt.work).toMatchObject({
      links: [{ role: 'origin', conversation: { namespace: 'mitzo', conversationId: 'origin' } }],
      assignments: [],
      attempts: [],
    });
    const pin = snapshot.artifacts.at(-1)!;
    const artifact = f.artifacts.read(pin.artifactId, pin.revision);
    expect(artifact.sha256).toBe(pin.sha256);
    expect(JSON.parse(artifact.bytes.toString())).toEqual(preview.packet);
    expect(artifact.sourceKind).toBe('source_capture');
    const view = f.capture.read('item', snapshot.snapshotId, actor);
    expect(view.packet).toEqual(preview.packet);
    expect(view.sourceHref).toBe('/chat/origin?telosItem=item&telosSource=' + snapshot.snapshotId);
    expect(view.available).toBe(true);
    f.events.append('origin', 'user_message', { messageId: 'later', text: 'Later discussion' });
    f.db
      .prepare("UPDATE items SET intent='A later brief',updated_at='later' WHERE id='item'")
      .run();
    expect(await new TelosSourceCapture(f.options).adopt(input, actor)).toEqual(receipt);
    f.events.hideSession('origin');
    expect(f.capture.read('item', snapshot.snapshotId, actor)).toMatchObject({
      packet: preview.packet,
      available: false,
    });
    expect(f.artifacts.read(pin.artifactId, pin.revision)).toEqual(artifact);
    expect(
      f.work.forConversation({ namespace: 'mitzo', conversationId: 'origin' }, actor),
    ).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM telos_work_allocation_outbox').all()).toEqual([]);
  });

  it('supports maximum request IDs and refuses an empty reviewed exchange before retaining bytes', async () => {
    const f = fixture();
    await expect(
      f.capture.preview({ itemId: 'item', selection: { ...f.selection, messageIds: [] } }, actor),
    ).rejects.toThrow();
    expect(f.artifacts.list({ itemId: 'item' })).toEqual([]);
    const preview = await f.preview();
    expect(
      (
        await f.capture.adopt(
          {
            itemId: 'item',
            requestId: 'r'.repeat(200),
            expectedRevision: preview.packet.workRevision,
            previewSha256: preview.sha256,
            selection: f.selection,
          },
          actor,
        )
      ).work.sources,
    ).toHaveLength(1);
    expect(() => f.capture.read('other', 'missing', actor)).toThrow();
  });

  it('refuses reference metadata that claims blocks absent from the retained approved packet', async () => {
    const f = fixture();
    const preview = await f.preview();
    const receipt = await f.capture.adopt(
      {
        itemId: 'item',
        requestId: 'real',
        expectedRevision: preview.packet.workRevision,
        previewSha256: preview.sha256,
        selection: f.selection,
      },
      actor,
    );
    const real = receipt.work.sources[0];
    f.work.execute(
      {
        operation: 'source',
        itemId: 'item',
        requestId: 'unverified-reference',
        expectedRevision: receipt.work.revision,
        snapshot: {
          ...real,
          snapshotId: 'unverified',
          selection: {
            ...real.selection,
            kind: 'selected',
            messageIds: ['request', 'approved'],
            throughSequence: f.selection.boundary.sequence,
            blockIds: ['not-in-the-packet'],
          },
        },
      },
      actor,
    );
    expect(() => f.capture.read('item', 'unverified', actor)).toThrow();
  });

  it('refuses changed source digests, stale briefs, revoked access and caller-supplied content before writing', async () => {
    const f = fixture();
    const preview = await f.preview();
    const input = {
      itemId: 'item',
      requestId: 'adopt',
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
      selection: f.selection,
    };
    await expect(
      f.capture.adopt({ ...input, previewSha256: 'a'.repeat(64) }, actor),
    ).rejects.toThrow();
    await expect(f.capture.adopt({ ...input, packet: preview.packet }, actor)).rejects.toThrow();
    f.revoke();
    await expect(f.capture.adopt(input, actor)).rejects.toThrow();
    await expect(
      f.capture.preview(
        { itemId: 'item', selection: f.selection },
        { kind: 'conversation', id: 'origin' },
      ),
    ).rejects.toThrow();
    expect(f.artifacts.list({ itemId: 'item' })).toEqual([]);
    expect(f.work.read('item', actor).sources).toEqual([]);
    const other = fixture();
    const old = await other.preview();
    other.db
      .prepare(
        "UPDATE items SET rationale='Changed after review',updated_at='changed' WHERE id='item'",
      )
      .run();
    await expect(
      other.capture.adopt(
        {
          ...input,
          selection: other.selection,
          previewSha256: old.sha256,
          expectedRevision: old.packet.workRevision,
        },
        actor,
      ),
    ).rejects.toThrow();
    expect(other.artifacts.list({ itemId: 'item' })).toEqual([]);
  });

  it('recovers the same retained packet after a failure between artifact retention and origin linking', async () => {
    const f = fixture();
    const preview = await f.preview();
    const input = {
      itemId: 'item',
      requestId: 'lost-response',
      expectedRevision: preview.packet.workRevision,
      previewSha256: preview.sha256,
      selection: f.selection,
    };
    const execute = vi.spyOn(f.work, 'execute').mockImplementationOnce(() => {
      throw Error('Simulated interruption after retention');
    });
    await expect(f.capture.adopt(input, actor)).rejects.toThrow(/Simulated/);
    expect(f.artifacts.list({ itemId: 'item' })).toHaveLength(1);
    expect(f.work.read('item', actor).sources).toEqual([]);
    execute.mockRestore();
    f.events.append('origin', 'user_message', {
      messageId: 'after-crash',
      text: 'Do not recompile a different packet',
    });
    const receipt = await new TelosSourceCapture(f.options).adopt(input, actor);
    expect(receipt.work.sources).toHaveLength(1);
    expect(f.artifacts.list({ itemId: 'item' })).toHaveLength(1);
    expect(await f.capture.adopt(input, actor)).toEqual(receipt);
    await expect(f.capture.adopt({ ...input, itemId: 'other' }, actor)).rejects.toThrow();
    expect(f.artifacts.list({ itemId: 'other' })).toEqual([]);
  });

  it('keeps one source independently linked to two items and pins selected older artifact bytes', async () => {
    const f = fixture();
    const save = (text: string) =>
      f.artifacts.save({
        itemId: 'item',
        filename: 'acoustics.md',
        title: 'Acoustics',
        sessionId: 'origin',
        bytes: Buffer.from(text),
      });
    const original = save('Approved plan r1');
    save('Later plan r2');
    f.selection.artifacts.push({
      artifactId: original.id,
      revision: original.revision,
      sha256: original.sha256,
    });
    for (const itemId of ['item', 'other']) {
      const preview = await f.preview(itemId);
      expect(preview.packet.context.artifacts[0].contentBase64).toBe(
        Buffer.from('Approved plan r1').toString('base64'),
      );
      await f.capture.adopt(
        {
          itemId,
          requestId: 'adopt-' + itemId,
          expectedRevision: preview.packet.workRevision,
          previewSha256: preview.sha256,
          selection: f.selection,
        },
        actor,
      );
    }
    expect(
      f.work
        .forConversation({ namespace: 'mitzo', conversationId: 'origin' }, actor)
        .map((link) => link.itemId),
    ).toEqual(['item', 'other']);
    expect(f.artifacts.read(original.id, 1).bytes.toString()).toBe('Approved plan r1');
    expect(f.artifacts.read(original.id, 2).bytes.toString()).toBe('Later plan r2');
  });
});
