import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { throwIfApprovalExpired, expiredApprovalToolResult } from '@mitzo/harness';
import type { TelosWorkAssignment } from '@mitzo/protocol';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { drainRejectedTelosAuthority } from './telos-authority-diagnostic.js';
import type { TelosItemStore } from './telos-item-store.js';
import type { TelosWorkStore } from './telos-work-store.js';
import { TelosGetItemInput, TelosUpdateItemInput } from './telos-item-tools.js';
import type { TelosToolResult } from './telos-tool.js';
import { retainCallbackOutcome, retainedCallbackOutcome } from './turn-callbacks.js';

type Name = 'TelosGetItem' | 'TelosUpdateItem';
export interface NativeTelosItemOwners {
  context: Pick<
    NativeHostToolContext,
    | 'signal'
    | 'selectedRole'
    | 'toolName'
    | 'requestHash'
    | 'conversationId'
    | 'assertCurrent'
    | 'assertCurrentSync'
  >;
  items: TelosItemStore;
  work: TelosWorkStore;
  assertProgressConsent?: () => void;
  approve(
    name: Name,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult>;
}
function unavailable(): never {
  throw Error('Original Telos lead and item scope unavailable');
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Original authenticated call only. Canonical role assignments and the item
 * owner's guarded transaction supply scope and linearize a new mutation. */
export async function executeNativeTelosItemOperation(
  owners: NativeTelosItemOwners,
  name: Name,
  rawOriginal: unknown,
): Promise<TelosToolResult> {
  let mutationStarted = false;
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
      owners.assertProgressConsent?.();
      const renewed: unknown = ctx.assertCurrentSync();
      if (renewed !== undefined) {
        drainRejectedTelosAuthority(renewed, 'item-authority', ctx);
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
    throwIfApprovalExpired(permission);
    if (permission.behavior !== 'allow' || !isDeepStrictEqual(permission.updatedInput, input))
      unavailable();
    if (name === 'TelosGetItem')
      return {
        content: JSON.stringify({ ok: true, item: items.readGuarded(input.itemId, current) }),
        isError: false,
      };
    mutationStarted = true;
    const receipt = items.updateGuarded(
      TelosUpdateItemInput.parse(input),
      ctx.conversationId,
      current,
      () => work.assertLifecycleActive(input.itemId),
    );
    // The real owner acknowledged COMMIT. Never renew authority after its effect.
    return { content: JSON.stringify({ ok: true, ...receipt }), isError: false };
  } catch (error) {
    const outcome = error instanceof Error ? retainedCallbackOutcome(error) : undefined;
    const expired = expiredApprovalToolResult(error);
    if (expired)
      return retainCallbackOutcome(expired, outcome === 'unknown' ? 'unknown' : 'settled');
    const message = error instanceof Error ? error.message : '';
    const known = [
      'Telos item changed;',
      'Unfinished milestones;',
      'Update request identity reused',
    ];
    const result = {
      isError: true,
      content: known.some((prefix) => message.startsWith(prefix))
        ? message
        : 'Telos item operation unavailable. Preserve the original request; a committed update is recoverable only by its exact request and input.',
    };
    return retainCallbackOutcome(
      result,
      outcome === 'unknown'
        ? 'unknown'
        : !mutationStarted || outcome === 'settled'
          ? 'settled'
          : 'unknown',
    );
  }
}
