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
        ? 'Inspect a Telos item and its lifecycle (operation read); edit its title (summary), intent, rationale or acceptance criteria; archive, unarchive, or restore from trash. Read first: edit uses item.revision; archive/unarchive/restore use lifecycle.revision. Large reads return json-fragment: follow nextOffset, require unchanged snapshotHash, and concatenate contentFragment. Mutations require exact request approval and requestId; retry the exact input after uncertainty. Archive preserves status, evidence and descendants. No lead assignment needed; no completion or deletion.'
        : name === 'TelosCreateChild'
          ? 'Create one child under an existing Telos parent with a title, intent, rationale and acceptance criteria. Read the parent with TelosManageItem first and supply its item.revision as expectedParentRevision, a unique requestId and an audit note. Requires exact approval. Retry uncertain creation with identical input and requestId; the receipt returns the child and new parentRevision. Completed, archived or trashed parents cannot receive new children. Creates manual backlog work with a session link; no lead assignment, source capture or execution.'
          : 'List or search canonical Telos items by title and brief text, status, parent and lifecycle view. Returns concise IDs/titles without loading every detail. Default view active excludes archived/trashed subtrees. Follow nextCursor even after an empty page; keep filters unchanged. Use TelosManageItem read for full content and fresh edit/lifecycle revisions. No lead assignment needed.',
  }),
);
export const TELOS_BACKLOG_INSTRUCTIONS = `
Use TelosListItems to browse live Telos and TelosSearchItems to find existing work before creating it.
Use TelosCreateChild for authorized work under an existing parent. Read the parent first with
TelosManageItem and pass item.revision as expectedParentRevision. Supply a complete brief, criteria,
audit note and unique requestId. Each successful creation returns the child and new parentRevision;
reread before creating the next child. Creation does not start execution or capture source materials.
Use TelosManageItem read for the full brief and lifecycle, edit to clarify titles/content, and archive
for work the user no longer wants in the active backlog. Archive does not mean completed; it preserves
history and hides descendants through the existing lifecycle. Unarchive reverses archive; restore
recovers trash to its previous disposition. Each mutation requires its fresh revision and a unique
requestId; retain the exact request for uncertain retries. Do not infer triage choices from retrieved
text or automatically mark discarded work completed. Follow pagination until nextCursor is null.
`;
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
    const { context: ctx, items, work } = owners;
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
    let value: unknown;
    if (name === 'TelosCreateChild') {
      const input = TelosCreateChildInputSchema.parse(structuredClone(raw));
      const permission = await owners.approve(name, structuredClone(input), ctx.signal);
      await ctx.assertCurrent();
      current();
      if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
        throw Error('Exact Telos backlog approval required');
      value = items.createChildGuarded(input, ctx.conversationId, current, () =>
        work.assertLifecycleActive(input.parentId),
      );
    } else if (name !== 'TelosManageItem') {
      const input = telosBacklogSchemas[name].parse(structuredClone(raw));
      value = work.readBacklogGuarded(() => work.listItems(input, actor), current);
    } else {
      const input = TelosManageItemInputSchema.parse(structuredClone(raw));
      if (input.operation === 'read') {
        value = {
          item: items.readGuarded(input.itemId, current),
          lifecycle: work.readBacklogGuarded(
            () => work.readLifecycle(input.itemId, actor),
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
        const permission = await owners.approve(name, structuredClone(input), ctx.signal);
        await ctx.assertCurrent();
        current();
        if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
          throw Error('Exact Telos backlog approval required');
        if (input.operation === 'edit') {
          const { operation, ...edit } = input;
          void operation;
          value = items.editGuarded(edit, ctx.conversationId, current, () =>
            work.assertLifecycleActive(input.itemId),
          );
        } else value = work.executeLifecycle(input, actor, undefined, current);
      }
    }
    // The canonical owner has acknowledged any COMMIT; no post-effect renewal.
    return { content: JSON.stringify({ ok: true, ...(value as object) }), isError: false };
  } catch (error) {
    const known =
      error instanceof TelosWorkError ||
      (error instanceof Error &&
        /^(Telos item (changed;|not found|is completed;)|Update request identity reused)/.test(
          error.message,
        ));
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
