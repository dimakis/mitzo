import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { TelosWorkAssignment } from '@mitzo/protocol';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import type { TelosItemStore } from './telos-item-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import { TelosGetItemInput, TelosUpdateItemInput } from './telos-item-tools.js';
import type { TelosToolResult } from './telos-tool.js';

type Name = 'TelosGetItem' | 'TelosUpdateItem';
export interface NativeTelosItemOwners {
  context: NativeHostToolContext;
  items: TelosItemStore;
  work: TelosWorkStore;
  approve(
    name: Name,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult>;
}
function unavailable(): never {
  throw Error('Original native Telos item scope unavailable');
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Original signed native call only. Canonical role assignments and the item
 * owner's guarded transaction supply scope and linearize a new mutation. */
export async function executeNativeTelosItemOperation(
  owners: NativeTelosItemOwners,
  name: Name,
  rawOriginal: unknown,
): Promise<TelosToolResult> {
  try {
    const { context: ctx, work, items } = owners;
    if (name !== 'TelosGetItem' && name !== 'TelosUpdateItem') unavailable();
    const input = (name === 'TelosGetItem' ? TelosGetItemInput : TelosUpdateItemInput).parse(
      structuredClone(rawOriginal),
    );
    const role = structuredClone(ctx.selectedRole);
    if (!role || role.role !== 'lead') unavailable();
    let originalAssignment: TelosWorkAssignment | undefined;
    const current = () => {
      ctx.signal.throwIfAborted();
      const renewed: unknown = ctx.assertCurrentSync();
      if (renewed !== undefined) {
        void Promise.resolve(renewed).catch(() => {});
        unavailable();
      }
      if (
        ctx.toolName !== name ||
        ctx.requestHash !== hash(rawOriginal) ||
        !isDeepStrictEqual(ctx.selectedRole, role)
      )
        unavailable();
      const selected = work.read(role.itemId, { kind: 'conversation', id: ctx.conversationId });
      const assignment = selected.assignments.find((entry) => entry.role === 'lead');
      if (
        !assignment ||
        assignment.conversation.namespace !== 'mitzo' ||
        assignment.conversation.conversationId !== ctx.conversationId ||
        (role.itemKind != null && role.itemKind !== selected.kind) ||
        (originalAssignment && !isDeepStrictEqual(assignment, originalAssignment))
      )
        unavailable();
      originalAssignment ??= structuredClone(assignment);
      if (input.itemId !== role.itemId) {
        // This existing owner supplies relationship evidence, not a mutation grant.
        const target = work.readDelegationTarget(ctx.conversationId, input.itemId, input.itemId);
        if (target.record.parentId !== role.itemId) unavailable();
      }
      ctx.signal.throwIfAborted();
    };
    current();
    const permission = await owners.approve(name, structuredClone(input), ctx.signal);
    await ctx.assertCurrent();
    current();
    if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
      unavailable();
    if (name === 'TelosGetItem')
      return {
        content: JSON.stringify({ ok: true, item: items.readGuarded(input.itemId, current) }),
        isError: false,
      };
    const receipt = items.updateGuarded(
      TelosUpdateItemInput.parse(input),
      ctx.conversationId,
      current,
      () => work.assertLifecycleActive(input.itemId),
    );
    // The real owner acknowledged COMMIT. Never renew authority after its effect.
    return { content: JSON.stringify({ ok: true, ...receipt }), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = [
      'Telos item changed;',
      'Unfinished milestones;',
      'Update request identity reused',
    ];
    return {
      isError: true,
      content: known.some((prefix) => message.startsWith(prefix))
        ? message
        : 'Telos item operation unavailable. Preserve the original request; a committed update is recoverable only by its exact request and input.',
    };
  }
}
