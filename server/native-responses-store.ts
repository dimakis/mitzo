import Database from 'better-sqlite3';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  OrdinaryLocalResponsesCommandAdmissionSchema,
  VertexAdcCustodySchema,
} from '@mitzo/protocol';
import { chmodSync, closeSync, openSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import type { ConversationMessage, ResponsesCheckpoint, ToolDefinition } from '@mitzo/harness';

export const OrdinaryResponsesCustodySchema = z
  .strictObject({
    version: z.literal(1),
    authSessionId: z.string().min(1).max(200),
    binding: OrdinaryLocalResponsesCommandAdmissionSchema.shape.binding,
    workspace: OrdinaryLocalResponsesCommandAdmissionSchema.shape.workspace,
    credentialAuthority: VertexAdcCustodySchema.optional(),
    nativeSelection: z
      .strictObject({
        model: z.string().min(1).max(200),
        reasoningEffort: z.string().max(64).nullable(),
      })
      .optional(),
  })
  .superRefine((custody, ctx) => {
    const google = custody.binding.account.provider === 'google-vertex';
    if (
      google
        ? !custody.credentialAuthority || !custody.nativeSelection
        : custody.credentialAuthority !== undefined || custody.nativeSelection !== undefined
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Native credential and model custody does not match the owning provider',
      });
  });
export type OrdinaryResponsesCustody = z.infer<typeof OrdinaryResponsesCustodySchema>;
const QueueSchema = z.strictObject({
  queued: z.array(z.string().min(1).max(200).regex(/^\S+$/)).max(32),
  active: z.string().min(1).max(200).nullable(),
  paused: z.boolean(),
  cancelledIds: z.array(z.string().min(1).max(200)).max(100),
});
export type NativeResponsesQueue = z.infer<typeof QueueSchema>;
export interface NativeResponsesState {
  status: 'running' | 'idle' | 'interrupted';
  nativeSelection?: { model: string; reasoningEffort: string | null };
  checkpoint?: ResponsesCheckpoint;
  history: ConversationMessage[];
}

/** Server-only continuation storage, deliberately separate from public transcript metadata.
 * One server process owns this database. Call recoverAtStartup only before accepting work.
 */
export class NativeResponsesStore {
  private db: Database.Database;
  constructor(path: string) {
    // New files are created with 0600 atomically; chmod also tightens existing files.
    // The enclosing directory must be private, as required by the integration contract.
    if (path !== ':memory:') {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS native_responses (conversation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL)',
    );
    const columns = this.db.prepare('PRAGMA table_info(native_responses)').all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'custody'))
      this.db.exec('ALTER TABLE native_responses ADD COLUMN custody TEXT');
    if (!columns.some((column) => column.name === 'ordinary_queue'))
      this.db.exec('ALTER TABLE native_responses ADD COLUMN ordinary_queue TEXT');
  }
  /** Exact admitted definitions survive restart. Drift refuses resume rather than replacing tools. */
  bindAgentTools(
    id: string,
    binding: AccountBinding,
    input: {
      profileHash: string;
      tools: ToolDefinition[];
      apiTools?: { wireName: string; reference: import('@mitzo/protocol').AgentToolReference }[];
      customTools?: { wireName: string; reference: import('@mitzo/protocol').AgentToolReference }[];
      configuredTools?: {
        wireName: string;
        reference: import('@mitzo/protocol').AgentToolReference;
        sourceId: string;
        tool: string;
      }[];
    },
    resume: boolean,
  ): void {
    if (
      !/^[a-f0-9]{64}$/.test(input.profileHash) ||
      Buffer.byteLength(JSON.stringify(input)) > 1048576
    )
      throw Error('Agent tool snapshot is invalid');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS agent_tool_snapshots (conversation_id TEXT PRIMARY KEY, binding TEXT NOT NULL, snapshot TEXT NOT NULL)',
    );
    this.db
      .transaction(() => {
        const row = this.db
          .prepare('SELECT binding,snapshot FROM agent_tool_snapshots WHERE conversation_id=?')
          .get(id) as { binding: string; snapshot: string } | undefined;
        if (row) {
          if (row.binding !== this.bindingKey(binding))
            throw Error('Agent tool snapshot binding changed');
          if (!isDeepStrictEqual(JSON.parse(row.snapshot), input))
            throw Error('Agent tool catalog changed; start a new chat');
        } else {
          if (resume) throw Error('Admitted agent tool snapshot unavailable; start a new chat');
          this.db
            .prepare(
              'INSERT INTO agent_tool_snapshots(conversation_id,binding,snapshot) VALUES (?,?,?)',
            )
            .run(id, this.bindingKey(binding), JSON.stringify(input));
        }
      })
      .immediate();
  }
  readOrdinaryCustody(
    conversationId: string,
    binding: AccountBinding,
  ): OrdinaryResponsesCustody | undefined {
    const row = this.db
      .prepare('SELECT binding,custody FROM native_responses WHERE conversation_id=?')
      .get(conversationId) as { binding: string; custody: string | null } | undefined;
    if (!row || !row.custody) return undefined;
    if (row.binding !== this.bindingKey(binding))
      throw Error('Native Responses account/model binding changed');
    return OrdinaryResponsesCustodySchema.parse(JSON.parse(row.custody));
  }
  setOrdinaryCustody(
    conversationId: string,
    binding: AccountBinding,
    input: OrdinaryResponsesCustody,
  ): void {
    const custody = OrdinaryResponsesCustodySchema.parse(input);
    if (
      custody.binding.account.accountId !== binding.accountId ||
      custody.binding.account.provider !== binding.provider ||
      custody.binding.account.profileRevision !== binding.profileRevision
    )
      throw Error('Responses custody binding changed');
    this.db
      .transaction(() => {
        const state = this.load(conversationId, binding);
        const old = this.readOrdinaryCustody(conversationId, binding);
        if (old) {
          if (!isDeepStrictEqual(old, custody)) throw Error('Responses custody changed');
          return;
        }
        if (state) throw Error('Legacy Responses history cannot acquire custody');
        this.db
          .prepare(
            'INSERT INTO native_responses(conversation_id,binding,state,custody) VALUES (?,?,?,?)',
          )
          .run(
            conversationId,
            this.bindingKey(binding),
            JSON.stringify({ status: 'idle', history: [] }),
            JSON.stringify(custody),
          );
      })
      .immediate();
  }
  status(
    conversationId: string,
    binding: AccountBinding,
  ): NativeResponsesState['status'] | undefined {
    const row = this.db
      .prepare(
        "SELECT binding,json_extract(state,'$.status') AS status FROM native_responses WHERE conversation_id=?",
      )
      .get(conversationId) as { binding: string; status: string } | undefined;
    if (!row) return undefined;
    if (row.binding !== this.bindingKey(binding))
      throw Error('Native Responses account/model binding changed');
    return z.enum(['running', 'idle', 'interrupted']).parse(row.status);
  }
  /** Bounded private settings projection; metadata qualification never reads signed history. */
  frozenSettings(id: string, binding: AccountBinding) {
    const row = this.db
      .prepare(
        "SELECT binding,json_extract(state,'$.nativeSelection') AS selection,json_extract(state,'$.checkpoint.model') AS model FROM native_responses WHERE conversation_id=?",
      )
      .get(id) as { binding: string; selection: string | null; model: string | null } | undefined;
    if (!row) return undefined;
    if (row.binding !== this.bindingKey(binding))
      throw Error('Native Responses account/model binding changed');
    if (!row.selection) return undefined;
    return {
      selection: z
        .strictObject({
          model: z.string().min(1).max(200),
          reasoningEffort: z.string().max(64).nullable(),
        })
        .parse(JSON.parse(row.selection)),
      checkpointModel: row.model === null ? undefined : z.string().min(1).parse(row.model),
    };
  }
  /** Native scheduling identities only; immutable payload/settings stay in EventStore. */
  queue(id: string, binding: AccountBinding): NativeResponsesQueue {
    if (!this.readOrdinaryCustody(id, binding)) throw Error('Owned Responses custody required');
    const row = this.db
      .prepare('SELECT ordinary_queue FROM native_responses WHERE conversation_id=?')
      .get(id) as { ordinary_queue: string | null };
    const queue = QueueSchema.parse(
      row.ordinary_queue
        ? JSON.parse(row.ordinary_queue)
        : { queued: [], active: null, paused: false, cancelledIds: [] },
    );
    if (
      new Set(queue.queued).size !== queue.queued.length ||
      (queue.active && queue.queued.includes(queue.active))
    )
      throw Error('Responses queue identity changed');
    return queue;
  }
  private saveQueue(id: string, queue: NativeResponsesQueue) {
    this.db
      .prepare('UPDATE native_responses SET ordinary_queue=? WHERE conversation_id=?')
      .run(JSON.stringify(QueueSchema.parse(queue)), id);
  }
  enqueueCommand(id: string, binding: AccountBinding, commandId: string): boolean {
    return this.db
      .transaction(() => {
        const queue = this.queue(id, binding);
        if (
          queue.queued.includes(commandId) ||
          queue.active === commandId ||
          queue.cancelledIds.includes(commandId)
        )
          return false;
        if (queue.queued.length >= 32) throw Error('Responses queue is full');
        queue.queued.push(commandId);
        this.saveQueue(id, queue);
        return true;
      })
      .immediate();
  }
  claimNextCommand(
    id: string,
    binding: AccountBinding,
    canClaim: (commandId: string) => boolean,
  ): string | undefined {
    return this.db
      .transaction(() => {
        const queue = this.queue(id, binding),
          commandId = queue.queued[0];
        if (
          !commandId ||
          queue.active ||
          queue.paused ||
          this.status(id, binding) === 'running' ||
          !canClaim(commandId)
        )
          return undefined;
        queue.queued.shift();
        queue.active = commandId;
        this.saveQueue(id, queue);
        return commandId;
      })
      .immediate();
  }
  finishCommand(id: string, binding: AccountBinding, commandId: string): void {
    this.db
      .transaction(() => {
        const queue = this.queue(id, binding);
        if (queue.active !== commandId) throw Error('Responses active command changed');
        queue.active = null;
        this.saveQueue(id, queue);
      })
      .immediate();
  }
  pauseQueue(id: string, binding: AccountBinding, paused = true) {
    this.db
      .transaction(() => {
        const queue = this.queue(id, binding);
        queue.paused = paused;
        this.saveQueue(id, queue);
      })
      .immediate();
  }
  cancelQueuedCommand(
    id: string,
    binding: AccountBinding,
    commandId: string,
  ): 'cancelled' | 'not_queued' | 'not_found' {
    return this.db
      .transaction(() => {
        const queue = this.queue(id, binding);
        if (queue.active === commandId) return 'not_queued';
        if (!queue.queued.includes(commandId)) return 'not_found';
        queue.queued = queue.queued.filter((candidate) => candidate !== commandId);
        queue.cancelledIds = [commandId, ...queue.cancelledIds].slice(0, 100);
        this.saveQueue(id, queue);
        return 'cancelled';
      })
      .immediate();
  }
  private bindingKey(binding: AccountBinding) {
    return JSON.stringify([
      binding.accountId,
      binding.provider,
      binding.model,
      binding.profileRevision,
    ]);
  }
  load(conversationId: string, binding: AccountBinding): NativeResponsesState | undefined {
    const row = this.db
      .prepare('SELECT binding, state FROM native_responses WHERE conversation_id = ?')
      .get(conversationId) as { binding: string; state: string } | undefined;
    if (!row) return undefined;
    if (row.binding !== this.bindingKey(binding))
      throw new Error('Native Responses account/model binding changed');
    const state = JSON.parse(row.state) as NativeResponsesState & {
      checkpoint?: ResponsesCheckpoint & { historyLength?: number };
    };
    if (state.checkpoint && state.checkpoint.historyLength !== undefined) {
      state.checkpoint.history = structuredClone(
        state.history.slice(0, state.checkpoint.historyLength),
      );
      delete state.checkpoint.historyLength;
    }
    return state;
  }
  begin(conversationId: string, binding: AccountBinding): NativeResponsesState {
    return this.db.transaction(() => {
      const state = this.load(conversationId, binding) ?? { status: 'idle', history: [] };
      if (state.status === 'running')
        throw new Error('Native Responses conversation already running');
      state.status = 'running';
      this.save(conversationId, binding, state);
      return state;
    })();
  }
  save(conversationId: string, binding: AccountBinding, state: NativeResponsesState) {
    // Explicit fields only: credentials and runner configuration are never serialized.
    const checkpoint = state.checkpoint && {
      accountId: state.checkpoint.accountId,
      model: state.checkpoint.model,
      // Persist only the prefix boundary; the history itself already exists at state level.
      historyLength: state.checkpoint.history.length,
      input: state.checkpoint.input,
    };
    const result = this.db
      .prepare(
        'INSERT INTO native_responses(conversation_id,binding,state) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET state = excluded.state WHERE native_responses.binding = excluded.binding',
      )
      .run(
        conversationId,
        this.bindingKey(binding),
        JSON.stringify({
          status: state.status,
          history: state.history,
          checkpoint,
          ...(state.nativeSelection ? { nativeSelection: state.nativeSelection } : {}),
        }),
      );
    if (result.changes !== 1) throw new Error('Native Responses account/model binding changed');
  }
  recoverAtStartup() {
    this.db.exec(
      "UPDATE native_responses SET ordinary_queue=json_set(ordinary_queue,'$.paused',json('true')) WHERE json_extract(ordinary_queue,'$.active') IS NOT NULL",
    );
    this.db.exec(
      "UPDATE native_responses SET state = json_set(state, '$.status', 'interrupted') WHERE json_extract(state, '$.status') = 'running'",
    );
  }
  close() {
    this.db.close();
  }
}
