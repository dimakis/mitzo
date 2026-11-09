import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  TelosListItemsInputSchema,
  TelosManageItemInputSchema,
  TelosCreateChildInputSchema,
} from '@mitzo/protocol';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ToolDefinition } from '@mitzo/harness';
import type { TelosItemStore } from './telos-item-store.js';
import { TelosWorkError, type TelosWorkStore } from './telos-work-store.js';
import type { TelosToolResult } from './telos-tool.js';
import {
  TELOS_WORKFLOW_INSTRUCTIONS,
  withTelosWorkflowInstructions,
} from './telos-workflow-instructions.js';
import { createLogger } from './logger.js';

export const telosBacklogSchemas = {
  TelosListItems: TelosListItemsInputSchema,
  TelosSearchItems: TelosListItemsInputSchema.safeExtend({
    query: z.string().trim().min(1).max(256),
  }),
  TelosManageItem: TelosManageItemInputSchema,
  TelosCreateChild: TelosCreateChildInputSchema,
};
export type TelosBacklogToolName = keyof typeof telosBacklogSchemas;
export const isTelosBacklogTool = (name: string): name is TelosBacklogToolName =>
  Object.hasOwn(telosBacklogSchemas, name);
export const telosBacklogDefinitions: ToolDefinition[] = Object.entries(telosBacklogSchemas).map(
  ([name, schema]) => ({
    name,
    input_schema: { type: 'object', ...z.toJSONSchema(schema, { io: 'input' }) },
    description:
      name === 'TelosManageItem'
        ? 'Inspect a Telos item and lifecycle (read); edit its title, intent, rationale or acceptance criteria (edit); record evidence and optionally change status to active, acknowledged or completed (update); archive, unarchive or restore. Read first: edit/update use item.revision; lifecycle changes use lifecycle.revision. Complete unfinished children before the parent. Large reads return json-fragment: follow nextOffset with unchanged snapshotHash and concatenate contentFragment. Mutations require exact approval and requestId; retry uncertain delivery with identical input. No lead assignment needed. No permanent deletion.'
        : name === 'TelosCreateChild'
          ? 'Create one child with a complete brief and criteria: a feature item under an outcome or a session-sized slice under a feature. Creation saves backlog work and originating-chat provenance only. Verify supported reviewed role/session setup separately; report missing capability. Read the parent and supply item.revision or the prior parentRevision as expectedParentRevision, a unique requestId and audit note. Requires exact approval; retry uncertainty with identical input and ID. Completed, archived or trashed parents refuse creation. No source attachment, dedicated conversation, role assignment or execution occurs here.'
          : 'List or search canonical Telos items by title and brief text, status, parent and lifecycle view. Returns concise IDs/titles without loading every detail. Default view active excludes archived/trashed subtrees. Follow nextCursor even after an empty page; keep filters unchanged. Use TelosManageItem read for full content and fresh edit/lifecycle revisions. No lead assignment needed.',
  }),
);
const backlogOperations = `
Use TelosListItems to browse live Telos and TelosSearchItems to find existing work before creating it.
Use TelosCreateChild for authorized work under an existing parent. Read the parent first with
TelosManageItem and pass item.revision as expectedParentRevision. Supply a complete brief, criteria,
audit note and unique requestId. Each successful creation returns the child and new parentRevision;
reuse that revision for the next child under the same parent, and reread after a revision conflict.
Creation does not create a dedicated conversation, start execution or attach source files.
Verify a distinct retained working conversation for each slice through the reviewed Telos role setup
or exact lead delegation path. Shared originating-chat provenance is not those dedicated sessions.
If that path is unavailable, report session setup pending, not slice ready.
Keep titles and briefs readable: describe the outcome and next action briefly; save detailed evidence
and handoffs as named artifacts instead of filling the brief with paths and hashes.
When asked for review-ready child work, separately report which children exist, which source documents
are saved and which dedicated conversations are ready. Never treat creation alone as all three.
Use TelosManageItem read for the full brief and lifecycle, edit to clarify titles/content, and archive
for work the user no longer wants in the active backlog. Use update to persist milestone evidence and justified status changes, including
completion. Read item.revision first and complete unfinished children separately before the parent.
Use active to reopen work when new evidence invalidates completion. Archive does not mean completed; it preserves
history and hides descendants through the existing lifecycle. Unarchive reverses archive; restore
recovers trash to its previous disposition. Each mutation requires its fresh revision and a unique
requestId; retain the exact request for uncertain retries. Do not infer triage choices from retrieved
text or automatically mark discarded work completed. Follow pagination until nextCursor is null.
`;
export const TELOS_BACKLOG_INSTRUCTIONS = withTelosWorkflowInstructions(backlogOperations);

/** The ordinary OpenShell/role prompt may already carry the shared contract. */
export function telosBacklogInstructions(existingPrompt: string): string {
  return existingPrompt.includes(TELOS_WORKFLOW_INSTRUCTIONS)
    ? backlogOperations
    : TELOS_BACKLOG_INSTRUCTIONS;
}
export interface TelosBacklogContext {
  operatorId: string;
  conversationId: string;
  toolName: string;
  requestHash: string;
  signal: AbortSignal;
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
}
export async function executeTelosBacklogOperation(
  owners: {
    context: TelosBacklogContext;
    items: TelosItemStore;
    work: TelosWorkStore;
    approve(
      name: TelosBacklogToolName,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<PermissionResult>;
  },
  name: TelosBacklogToolName,
  raw: unknown,
): Promise<TelosToolResult> {
  try {
    const { context: ctx } = owners;
    const current = () => {
      ctx.signal.throwIfAborted();
      const result: unknown = ctx.assertCurrentSync();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw Error('Synchronous Telos authority required');
      }
      if (
        !ctx.operatorId?.trim() ||
        !ctx.conversationId?.trim() ||
        ctx.toolName !== name ||
        ctx.requestHash !== createHash('sha256').update(JSON.stringify(raw)).digest('hex')
      )
        throw Error('Original Telos backlog call required');
    };
    current();
    const actor = { kind: 'operator' as const, id: ctx.operatorId };
    const approve = async (input: Record<string, unknown>) => {
      const permission = await owners.approve(name, structuredClone(input), ctx.signal);
      await ctx.assertCurrent();
      current();
      if (permission.behavior !== 'allow')
        throw new TelosWorkError(
          'unauthorized',
          'Telos change did not receive approval. No update was applied; reconnect the chat if its approval card could not be delivered.',
        );
      if (!isDeepStrictEqual(permission.updatedInput, input))
        throw new TelosWorkError(
          'unauthorized',
          'Telos approval changed the requested input. Review and approve the exact change again.',
        );
    };
    let value: unknown;
    if (name === 'TelosCreateChild') {
      const input = TelosCreateChildInputSchema.parse(structuredClone(raw));
      await approve(input);
      const receipt = owners.items.createChildGuarded(input, ctx.conversationId, current, () =>
        owners.items.assertLifecycleActive(input.parentId),
      );
      value = {
        ...receipt,
        preparation: {
          dedicatedConversationCreated: false,
          sourceFilesSaved: false,
          originatingConversationId: ctx.conversationId,
        },
      };
    } else if (name !== 'TelosManageItem') {
      const input = telosBacklogSchemas[name].parse(structuredClone(raw));
      value = owners.work.readBacklogGuarded(() => owners.work.listItems(input, actor), current);
    } else {
      const input = TelosManageItemInputSchema.parse(structuredClone(raw));
      if (input.operation === 'read') {
        value = {
          item: owners.items.readGuarded(input.itemId, current),
          lifecycle: owners.work.readBacklogGuarded(
            () => owners.work.readLifecycle(input.itemId, actor),
            current,
          ),
        };
        const full = JSON.stringify(value);
        if ((input.offset ?? 0) > 0 || Buffer.byteLength(full) > 48 * 1024) {
          const offset = input.offset ?? 0;
          if (offset >= full.length)
            throw new TelosWorkError(
              'invalid',
              'Invalid read offset; use nextOffset from the previous page',
            );
          const end = Math.min(offset + 8192, full.length);
          value = {
            format: 'json-fragment',
            snapshotHash: createHash('sha256').update(full).digest('hex'),
            offset,
            contentFragment: full.slice(offset, end),
            nextOffset: end < full.length ? end : null,
          };
        }
      } else {
        await approve(input);
        if (input.operation === 'edit') {
          const { operation, ...edit } = input;
          void operation;
          value = owners.items.editGuarded(edit, ctx.conversationId, current, () =>
            owners.items.assertLifecycleActive(input.itemId),
          );
        } else if (input.operation === 'update') {
          const { operation, ...update } = input;
          void operation;
          value = owners.items.updateGuarded(update, ctx.conversationId, current, () =>
            owners.items.assertLifecycleActive(input.itemId),
          );
        } else value = owners.work.executeLifecycle(input, actor, undefined, current);
      }
    }
    // The canonical owner has acknowledged any COMMIT; no post-effect renewal.
    let content = JSON.stringify({ ok: true, ...(value as object) });
    // Canonical receipts retain full bytes. Do not lose an acknowledged write
    // merely because a legacy brief/history exceeds the host transport bound.
    if (
      Buffer.byteLength(content) > 48 * 1024 &&
      value !== null &&
      typeof value === 'object' &&
      'item' in value
    ) {
      const receipt = value as {
        item: { id: string; revision: string; status: string; updatedAt: string };
        parentRevision?: string;
        update?: unknown;
        preparation?: unknown;
      };
      content = JSON.stringify({
        ok: true,
        item: {
          id: receipt.item.id,
          revision: receipt.item.revision,
          status: receipt.item.status,
          updatedAt: receipt.item.updatedAt,
        },
        parentRevision: receipt.parentRevision,
        update: receipt.update,
        preparation: receipt.preparation,
        detailOmitted: true,
      });
    }
    return { content, isError: false };
  } catch (error) {
    const known =
      error instanceof TelosWorkError ||
      (error instanceof Error &&
        /^(Telos item (changed;|not found|is completed;)|Update request identity reused|Unfinished milestones;)/.test(
          error.message,
        ));
    if (!known && !(error instanceof z.ZodError)) {
      const code =
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^SQLITE_[A-Z_]+$/.test(error.code)
          ? error.code
          : 'CONTEXT_OR_STORAGE_UNAVAILABLE';
      createLogger('telos-backlog').warn(
        'Telos backlog operation failed; original request retained for recovery',
        { tool: name, code },
      );
    }
    return {
      isError: true,
      content:
        error instanceof z.ZodError
          ? 'Invalid Telos backlog input: ' + z.prettifyError(error)
          : known
            ? (error as Error).message
            : 'Telos backlog operation unavailable; mutation not confirmed. Preserve the exact requestId and input for recovery.',
    };
  }
}
