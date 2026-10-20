import type { EventStore } from './event-store.js';
import type Database from 'better-sqlite3';
import type { SessionUpsert } from './session-metadata-store.js';
import { AccountBindingSchema } from './account-binding.js';
import {
  OrdinarySessionPreparationReceiptSchema,
  OrdinarySessionPreparationReceiptV2Schema,
  type OrdinarySessionPreparationReceiptV2,
} from './ordinary-prepared-session.js';
import type { OrdinaryWorkspaceSettings } from './ordinary-workspace.js';
import type { OrdinaryLocalCommandSelection } from './ordinary-local-admission.js';
import { isDeepStrictEqual } from 'node:util';

type Command = Parameters<EventStore['admitOrdinaryLocalCommand']>[2];
type Owner = Pick<
  EventStore,
  | 'getSession'
  | 'getSessionRuntimeBinding'
  | 'createSessionWithRuntimeBinding'
  | 'getSendCommand'
  | 'getOrdinaryInitialCommandId'
  | 'getLatestOrdinaryCommandAdmission'
> & {
  database(): Database.Database | null;
  admit(
    meta: SessionUpsert,
    binding: unknown,
    command: Command,
    operationId: string,
  ): ReturnType<EventStore['admitOrdinaryLocalCommand']>;
};
type Row = { receipt: string; metadata: string };

/** Borrows the existing EventStore transaction and preparation/send ledgers.
 * Only the explicitly versioned ordinary kind is handled here. */
export class OrdinaryWorkspaceSessionStore {
  constructor(private owner: Owner) {}
  private get db() {
    const db = this.owner.database();
    if (!db) throw Error('Ordinary workspace session inventory unavailable');
    return db;
  }
  private row(id: string): Row | undefined {
    return this.db
      .prepare('SELECT receipt,metadata FROM ordinary_session_preparations WHERE operation_id=?')
      .get(id) as Row | undefined;
  }
  get(id: string): OrdinarySessionPreparationReceiptV2 | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const raw = JSON.parse(row.receipt);
    if (raw?.version !== 2) {
      OrdinarySessionPreparationReceiptSchema.parse(raw);
      return undefined;
    }
    const receipt = OrdinarySessionPreparationReceiptV2Schema.parse(raw);
    if (receipt.allocationOperationId !== id)
      throw Error('Ordinary preparation operation identity changed');
    return receipt;
  }
  forConversation(id: string) {
    const row = this.db
      .prepare('SELECT operation_id FROM ordinary_session_preparations WHERE session_id=?')
      .get(id) as { operation_id: string } | undefined;
    return row ? this.get(row.operation_id) : undefined;
  }
  private assertMetadata(receipt: OrdinarySessionPreparationReceiptV2, meta: SessionUpsert) {
    const saved = this.row(receipt.allocationOperationId);
    const current = this.owner.getSession(receipt.sessionId);
    const snapshot = (value: SessionUpsert) => ({
      sessionId: value.sessionId,
      ordinaryWorkspaceId: value.ordinaryWorkspaceId,
      repositoryWorkspaceId: value.repositoryWorkspaceId ?? null,
      cwd: value.cwd,
      accountBinding: value.accountBinding,
      agentProfile: value.agentProfile,
      agentContext: value.agentContext,
      selectedModel: value.selectedModel ?? null,
      reasoningEffort: value.reasoningEffort ?? null,
      mode: value.mode,
    });
    if (
      !saved ||
      !current ||
      meta.ordinaryWorkspaceId !== receipt.workspaceId ||
      meta.repositoryWorkspaceId != null ||
      !isDeepStrictEqual(snapshot(JSON.parse(saved.metadata)), snapshot(meta)) ||
      !isDeepStrictEqual(snapshot(current), snapshot(meta)) ||
      !isDeepStrictEqual(
        this.owner.getSessionRuntimeBinding(meta.sessionId),
        receipt.settings.binding,
      )
    )
      throw Error('Original ordinary workspace preparation metadata required');
  }
  prepare(
    meta: SessionUpsert,
    input: {
      allocationOperationId: string;
      preparationFingerprint: string;
      settings: OrdinaryWorkspaceSettings;
      delegationAttemptId?: string;
    },
  ) {
    const receipt = OrdinarySessionPreparationReceiptV2Schema.parse({
      version: 2,
      ...input,
      sessionId: meta.sessionId,
      workspaceKind: 'ordinary',
      workspaceId: meta.ordinaryWorkspaceId,
      firstCommandId: null,
    });
    const account = AccountBindingSchema.parse(meta.accountBinding);
    const { settings } = receipt;
    if (
      meta.repositoryWorkspaceId != null ||
      !meta.cwd ||
      !meta.agentProfile ||
      !isDeepStrictEqual(settings.binding.account, {
        accountId: account.accountId,
        provider: account.provider,
        profileRevision: account.profileRevision,
      }) ||
      account.model !== settings.selection.model ||
      meta.selectedModel !== settings.selection.model ||
      meta.mode !== settings.selection.permission.mode ||
      (meta.reasoningEffort ?? null) !== settings.selection.thinking ||
      !isDeepStrictEqual(settings.selection.agent, {
        profileId: meta.agentProfile.profileId,
        revision: meta.agentProfile.revision,
        ...(meta.agentProfile.kind ? { kind: meta.agentProfile.kind } : {}),
      })
    )
      throw Error('Original ordinary workspace account, profile and settings required');
    return this.db
      .transaction(() => {
        const previous = this.get(receipt.allocationOperationId);
        if (previous) {
          if (!isDeepStrictEqual({ ...previous, firstCommandId: null }, receipt))
            throw Error('Ordinary workspace allocation cannot be replaced');
          this.assertMetadata(previous, meta);
          return previous;
        }
        if (
          this.row(receipt.allocationOperationId) ||
          this.owner.getSession(meta.sessionId) ||
          this.owner.getSendCommand(receipt.allocationOperationId)
        )
          throw Error('Ordinary workspace allocation requires a new identity');
        this.owner.createSessionWithRuntimeBinding(meta, settings.binding);
        this.db
          .prepare('INSERT INTO ordinary_session_preparations VALUES (?,?,?,?,?)')
          .run(
            receipt.allocationOperationId,
            receipt.sessionId,
            receipt.workspaceId,
            JSON.stringify(receipt),
            JSON.stringify(meta),
          );
        return receipt;
      })
      .immediate();
  }
  assert(
    id: string,
    meta: SessionUpsert,
    binding: unknown,
    selection: OrdinaryLocalCommandSelection,
  ) {
    const receipt = this.get(id);
    if (
      !receipt ||
      receipt.sessionId !== meta.sessionId ||
      !isDeepStrictEqual(receipt.settings.binding, binding) ||
      !isDeepStrictEqual(receipt.settings.selection, selection)
    )
      throw Error('Original ordinary workspace preparation required');
    this.assertMetadata(receipt, meta);
    return receipt;
  }
  admit(id: string, meta: SessionUpsert, binding: unknown, command: Command) {
    return this.db
      .transaction(() => {
        const receipt = this.assert(id, meta, binding, command.selection);
        if (
          command.clientMsgId === id ||
          (receipt.firstCommandId !== null && receipt.firstCommandId !== command.clientMsgId)
        )
          throw Error('Original ordinary workspace first command is frozen');
        const first = this.owner.getOrdinaryInitialCommandId(meta.sessionId);
        if (first && first !== command.clientMsgId)
          throw Error('Original ordinary workspace first command required');
        const result = this.owner.admit(meta, binding, command, id);
        this.db
          .prepare('UPDATE ordinary_session_preparations SET receipt=? WHERE operation_id=?')
          .run(JSON.stringify({ ...receipt, firstCommandId: command.clientMsgId }), id);
        return result;
      })
      .immediate();
  }
  settings(id: string): OrdinaryWorkspaceSettings | undefined {
    const receipt = this.forConversation(id);
    if (!receipt) return undefined;
    const meta = this.owner.getSession(id);
    if (
      !meta ||
      meta.repositoryWorkspaceId != null ||
      meta.ordinaryWorkspaceId !== receipt.workspaceId
    )
      throw Error('Original ordinary workspace identity required');
    const admission = this.owner.getLatestOrdinaryCommandAdmission(id);
    if (!admission) {
      if (receipt.firstCommandId !== null) return undefined;
      const saved = this.row(receipt.allocationOperationId)!;
      this.assertMetadata(receipt, JSON.parse(saved.metadata));
      return receipt.settings;
    }
    if (
      admission.workspace.workspaceId !== receipt.workspaceId ||
      admission.workspace.cwd !== meta.cwd ||
      !isDeepStrictEqual(admission.binding, receipt.settings.binding)
    )
      throw Error('Original ordinary workspace runtime and command required');
    return { ...receipt.settings, selection: admission.selection };
  }
}
