import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';
import { SessionRuntimeError } from './session-runtime-error.js';
import { CodexNativeFileChange } from './codex-native-file-change.js';

type HostCall = Readonly<{ callId: string; toolName: string; requestHash: string }>;
/** Process-local evidence from a fresh native RPC, never a JSON recovery grant. */
export type SettledInterruptedEffects = Readonly<{ readonly nativeEffects: unique symbol }>;
const observations = new WeakMap<
  SettledInterruptedEffects,
  {
    conversationId: string;
    target: CodexNativeTurnTarget;
    hostCalls: readonly HostCall[];
  }
>();

const Item = z.object({ id: z.string().min(1), type: z.string() }).passthrough();
const Page = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()),
});

const ItemPage = z.object({
  data: z.array(z.object({ turnId: z.string(), item: Item })).max(1),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
// Bound work independently of retained history. Oversized individual items still
// fail closed at the transport frame limit; never retry with full-turn hydration.
const MAX_INTERRUPTED_ITEMS = 128;
const AppliedFileChanges = z.object({
  status: z.literal('completed'),
  changes: z.array(CodexNativeFileChange).min(1),
});

/** Completed recovery never hydrates items. Eligible interrupted recovery reads
 * one item per frame and rechecks terminal identity after the final page.
 * The caller must retain and revalidate its account, transport and control epoch
 * across this await; the store separately checks current durable custody. */
export async function observeNativeRecoveryTurn(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  conversationId: string,
  target: CodexNativeTurnTarget,
  inspectInterruptedEffects: boolean,
  beforeAdditionalRead: () => Promise<void>,
) {
  const page = Page.parse(
    await request('thread/turns/list', {
      threadId: target.threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }),
  );
  if (
    !page.data.length ||
    page.data.some((turn) => !['completed', 'failed', 'interrupted'].includes(turn.status))
  )
    throw new SessionRuntimeError('provider_active');
  if (page.data.length !== 1 || page.data[0].id !== target.turnId)
    throw new SessionRuntimeError('provider_identity');
  const turn = page.data[0];
  const status = z.enum(['completed', 'failed', 'interrupted']).parse(turn.status);
  if (!inspectInterruptedEffects || status !== 'interrupted') return { status };
  if (turn.error !== null)
    throw Error('Interrupted native effects require an error-free turn observation');
  const calls: HostCall[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let exhausted = false;
  for (let count = 0; count < MAX_INTERRUPTED_ITEMS; count++) {
    await beforeAdditionalRead();
    const page = ItemPage.parse(
      await request('thread/items/list', {
        threadId: target.threadId,
        turnId: target.turnId,
        limit: 1,
        sortDirection: 'asc',
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!page.data.length && page.nextCursor !== null)
      throw Error('Interrupted native item page is incomplete');
    const entry = page.data[0];
    if (entry && entry.turnId !== target.turnId)
      throw Error('Interrupted native item belongs to another turn');
    if (entry) {
      const item = entry.item;
      if (ids.has(item.id)) throw Error('Interrupted native item identity is duplicated');
      ids.add(item.id);
      switch (item.type) {
        case 'userMessage':
        case 'agentMessage':
        case 'reasoning':
        case 'plan':
          break;
        case 'commandExecution':
          // A failed shell command with an observed exit code has a known
          // terminal result. This settles its effects; it does not mark the
          // command successful, rerun it, or erase its failure from history.
          if (
            !(item.status === 'completed' && item.exitCode === 0) &&
            !(
              item.status === 'failed' &&
              z.number().int().min(1).max(255).safeParse(item.exitCode).success
            )
          )
            throw Error('Interrupted native command effects remain unknown');
          break;
        case 'fileChange':
          // Native completed patches are already applied. Failed/in-progress
          // patches can be partial and must retain their original uncertainty.
          AppliedFileChanges.parse(item);
          break;
        case 'dynamicToolCall': {
          if (item.status !== 'completed' || item.success !== true || item.namespace != null)
            throw Error('Interrupted host tool effects remain unknown');
          const toolName = z.string().min(1).parse(item.tool);
          const args = z.record(z.string(), z.unknown()).parse(item.arguments);
          calls.push({
            callId: item.id,
            toolName,
            requestHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
          });
          break;
        }
        default:
          // MCP/collaboration and future native item types need
          // their own settlement contract. Never infer success from terminal turn metadata.
          throw Error('Interrupted native item effects are unsupported');
      }
    }
    if (page.nextCursor === null) {
      exhausted = true;
      break;
    }
    if (cursors.has(page.nextCursor)) throw Error('Interrupted native item cursor is duplicated');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  if (!exhausted) throw Error('Interrupted native item inspection budget exceeded');
  await beforeAdditionalRead();
  const final = Page.parse(
    await request('thread/turns/list', {
      threadId: target.threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }),
  );
  if (
    final.data.length !== 1 ||
    final.data[0].id !== target.turnId ||
    final.data[0].status !== 'interrupted' ||
    final.data[0].error !== null
  )
    throw Error('Interrupted native terminal identity changed during item inspection');
  const proof = Object.freeze({}) as SettledInterruptedEffects;
  observations.set(proof, { conversationId, target: structuredClone(target), hostCalls: calls });
  return { status, settledEffects: proof };
}

export function interruptedEffectCalls(
  proof: SettledInterruptedEffects,
  conversationId: string,
  target: CodexNativeTurnTarget,
) {
  const observation = observations.get(proof);
  if (
    !observation ||
    observation.conversationId !== conversationId ||
    !isDeepStrictEqual(observation.target, target)
  )
    throw Error('Fresh interrupted native effect observation unavailable');
  return observation.hostCalls;
}
