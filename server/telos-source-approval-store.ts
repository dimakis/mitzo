import {
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '@mitzo/protocol/telos-sqlite-owners';
import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import type { PendingTelosSourceReview } from '@mitzo/harness';
import {
  TelosSourcePermissionApproveRequestSchema,
  TelosSourcePermissionOperationSchema,
  TelosSourcePermissionReceiptSchema,
  TelosSourcePreviewSchema,
  TelosCanonicalOutcomeReceiptSchema,
  type TelosSourcePermissionApproveRequest,
  type TelosSourcePermissionOperation,
  type TelosSourcePermissionReceipt,
  type TelosSourcePreview,
} from '@mitzo/protocol';
import { TelosWorkError } from './telos-work-store.js';

export const sourceApprovalHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface RetainedTelosSourceApproval {
  id: string;
  actorId: string;
  proof: PendingTelosSourceReview;
  input: TelosSourcePermissionApproveRequest;
  operation: TelosSourcePermissionOperation;
  receipt: TelosSourcePermissionReceipt | null;
  preview: TelosSourcePreview;
  /** Private, irreversible refusal constraint captured from the original pending owner. */
  requiresLiveNativeCall?: true;
}
interface Row {
  data: string;
  data_sha256: string;
  receipt: string | null;
}
/** Recovery receipt only; canonical creation/context/artifacts retain their existing owners. */
export class TelosSourceApprovalStore {
  private db: Database.Database;
  #telosOwner: TelosOwnedDatabase;
  constructor(path: string) {
    this.#telosOwner = openTelosOwnedDatabase('canonical', path, { fileMustExist: true });
    this.db = this.#telosOwner.database;
    try {
      this.db.pragma('busy_timeout=5000');
      this.db.exec(`CREATE TABLE IF NOT EXISTS telos_work_source_approvals (
      id TEXT PRIMARY KEY, perm_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      tool_use_id TEXT NOT NULL, actor_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      data TEXT NOT NULL, data_sha256 TEXT NOT NULL, receipt TEXT, canonical_receipt TEXT,
      receipt_retrieved INTEGER NOT NULL DEFAULT 0,dismissed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id,tool_use_id));
      CREATE TRIGGER IF NOT EXISTS telos_source_approval_immutable BEFORE UPDATE OF id,perm_id,session_id,tool_use_id,actor_id,input_hash,data,data_sha256 ON telos_work_source_approvals BEGIN SELECT RAISE(ABORT,'Reviewed source approval is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS telos_source_approval_receipt_immutable BEFORE UPDATE OF receipt ON telos_work_source_approvals WHEN OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt BEGIN SELECT RAISE(ABORT,'Reviewed source receipt is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS telos_source_canonical_receipt_immutable BEFORE UPDATE OF canonical_receipt ON telos_work_source_approvals WHEN OLD.canonical_receipt IS NOT NULL AND NEW.canonical_receipt IS NOT OLD.canonical_receipt BEGIN SELECT RAISE(ABORT,'Canonical creation receipt is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS telos_source_approval_no_delete BEFORE DELETE ON telos_work_source_approvals BEGIN SELECT RAISE(ABORT,'Reviewed source approval is retained'); END;`);
      this.#telosOwner.seal();
    } catch (error) {
      this.#telosOwner.close();
      throw error;
    }
  }
  close() {
    this.#telosOwner.close();
  }
  private decode(row: Row | undefined): RetainedTelosSourceApproval | null {
    if (!row) return null;
    if (createHash('sha256').update(row.data).digest('hex') !== row.data_sha256)
      throw Error('Retained source approval integrity unavailable');
    const data = JSON.parse(row.data) as RetainedTelosSourceApproval;
    if ('requiresLiveNativeCall' in data && data.requiresLiveNativeCall !== true)
      throw Error('Retained native source provenance unavailable');
    data.input = TelosSourcePermissionApproveRequestSchema.parse(data.input);
    data.operation = TelosSourcePermissionOperationSchema.parse(data.operation);
    data.preview = TelosSourcePreviewSchema.parse(data.preview);
    if (
      sourceApprovalHash(data.preview.packet) !== data.preview.sha256 ||
      data.preview.sha256 !== data.input.previewSha256 ||
      data.actorId !== data.preview.packet.actorId
    )
      throw Error('Retained source preview integrity unavailable');
    data.receipt = row.receipt
      ? TelosSourcePermissionReceiptSchema.parse(JSON.parse(row.receipt))
      : null;
    if (
      data.receipt &&
      (data.receipt.permId !== data.proof.permId || data.receipt.sessionId !== data.proof.sessionId)
    )
      throw Error('Retained source receipt integrity unavailable');
    return data;
  }
  lookup(permId: string, sessionId: string, actorId: string) {
    const row = this.db
      .prepare('SELECT * FROM telos_work_source_approvals WHERE perm_id=?')
      .get(permId) as (Row & { actor_id: string; session_id: string }) | undefined;
    if (!row) return null;
    if (row.actor_id !== actorId || row.session_id !== sessionId)
      throw new TelosWorkError(
        'unauthorized',
        'Reviewed source approval belongs to another operator or conversation',
      );
    return this.decode(row);
  }
  find(
    permId: string,
    sessionId: string,
    actorId: string,
    input: TelosSourcePermissionApproveRequest,
  ) {
    const row = this.lookup(permId, sessionId, actorId);
    if (row && sourceApprovalHash(row.input) !== sourceApprovalHash(input))
      throw new TelosWorkError('conflict', 'Retry the exact original reviewed source request');
    return row;
  }
  prepare(
    proof: PendingTelosSourceReview,
    actorId: string,
    input: TelosSourcePermissionApproveRequest,
    operation: TelosSourcePermissionOperation,
    preview: TelosSourcePreview,
    requiresLiveNativeCall?: true,
  ) {
    return this.db
      .transaction(() => {
        const prior = this.find(proof.permId, proof.sessionId, actorId, input);
        if (prior) return prior;
        const retained: RetainedTelosSourceApproval = {
          id: randomUUID(),
          actorId,
          proof: structuredClone(proof),
          input: structuredClone(input),
          operation: structuredClone(operation),
          receipt: null,
          preview: structuredClone(preview),
          ...(requiresLiveNativeCall === true ? { requiresLiveNativeCall: true as const } : {}),
        };
        const data = JSON.stringify(retained);
        this.db
          .prepare(
            'INSERT INTO telos_work_source_approvals(id,perm_id,session_id,tool_use_id,actor_id,input_hash,data,data_sha256) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            retained.id,
            proof.permId,
            proof.sessionId,
            proof.toolUseId,
            actorId,
            sourceApprovalHash(input),
            data,
            createHash('sha256').update(data).digest('hex'),
          );
        return retained;
      })
      .immediate();
  }
  complete(id: string, receipt: TelosSourcePermissionReceipt) {
    TelosSourcePermissionReceiptSchema.parse(receipt);
    this.db
      .prepare('UPDATE telos_work_source_approvals SET receipt=COALESCE(receipt,?) WHERE id=?')
      .run(JSON.stringify(receipt), id);
  }
  observeCanonical(id: string, itemId: string, raw: unknown) {
    const receipt = TelosCanonicalOutcomeReceiptSchema.parse(raw);
    if (receipt.item.id !== itemId)
      throw new TelosWorkError('conflict', 'Canonical receipt identity differs');
    return this.db
      .transaction(() => {
        const previous = this.canonical(id);
        if (previous) {
          if (previous.item.id !== itemId)
            throw new TelosWorkError('conflict', 'Canonical creation identity changed');
          return previous;
        }
        this.db
          .prepare('UPDATE telos_work_source_approvals SET canonical_receipt=? WHERE id=?')
          .run(JSON.stringify(receipt), id);
        return receipt;
      })
      .immediate();
  }
  canonical(id: string) {
    const row = this.db
      .prepare('SELECT canonical_receipt FROM telos_work_source_approvals WHERE id=?')
      .get(id) as { canonical_receipt: string | null } | undefined;
    return row?.canonical_receipt
      ? TelosCanonicalOutcomeReceiptSchema.parse(JSON.parse(row.canonical_receipt))
      : null;
  }
  read(id: string, sessionId: string) {
    return this.decode(
      this.db
        .prepare('SELECT * FROM telos_work_source_approvals WHERE id=? AND session_id=?')
        .get(id, sessionId) as Row | undefined,
    );
  }
  recoveries(sessionId: string, actorId: string) {
    const rows = this.db
      .prepare(
        'SELECT * FROM telos_work_source_approvals WHERE session_id=? AND actor_id=? AND receipt_retrieved=0 AND dismissed=0 ORDER BY rowid LIMIT 101',
      )
      .all(sessionId, actorId) as Row[];
    if (rows.length > 100) throw Error('Too many retained source recoveries');
    return rows.map((row) => this.decode(row)!);
  }
  /** Exact completed original review only; not discovery, latest, or a new consent grant.
   * The caller must still check its current native operator and actual source owner. */
  approvedArtifactSelection(
    sessionId: string,
    operatorId: string,
    artifactId: string,
    revision: number,
  ) {
    if (!operatorId.trim()) throw Error('Current source operator unavailable');
    const rows = this.db
      .prepare(
        'SELECT * FROM telos_work_source_approvals WHERE session_id=? AND actor_id=? AND receipt IS NOT NULL LIMIT 101',
      )
      .all(sessionId, 'operator:' + operatorId) as Row[];
    if (rows.length > 100) throw Error('Too many retained source approvals');
    return rows.flatMap((row) => {
      const record = this.decode(row)!;
      const receipt = record.receipt!;
      const source = receipt.receipt.work.sources.find(
        (source) => source.snapshotId === receipt.sourceSnapshotId,
      );
      if (
        !source ||
        source.itemId !== receipt.receipt.work.itemId ||
        source.artifacts.at(-1)?.sha256 !== record.input.previewSha256
      )
        throw Error('Original source receipt selection unavailable');
      return source.artifacts
        .filter((pin) => pin.artifactId === artifactId && pin.revision === revision)
        .map((pin) => ({ itemId: source.itemId, pin, source }));
    });
  }
  retrieved(id: string) {
    this.db
      .prepare('UPDATE telos_work_source_approvals SET receipt_retrieved=1 WHERE id=?')
      .run(id);
  }
  dismiss(permId: string, sessionId: string, actorId: string) {
    if (!this.lookup(permId, sessionId, actorId)) return false;
    this.db
      .prepare('UPDATE telos_work_source_approvals SET dismissed=1 WHERE perm_id=?')
      .run(permId);
    return true;
  }
}
