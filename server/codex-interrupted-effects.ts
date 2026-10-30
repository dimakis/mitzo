import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';
import { SessionRuntimeError } from './session-runtime-error.js';

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

/** One native read serves both terminal identity and optional effect inspection.
 * The caller must retain and revalidate its account, transport and control epoch
 * across this await; the store separately checks current durable custody. */
export async function observeNativeRecoveryTurn(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  conversationId: string,
  target: CodexNativeTurnTarget,
  inspectInterruptedEffects: boolean,
) {
  const page = Page.parse(
    await request('thread/turns/list', {
      threadId: target.threadId,
      limit: 1,
      sortDirection: 'desc',
      itemsView: inspectInterruptedEffects ? 'full' : 'notLoaded',
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
  if (turn.itemsView !== 'full' || turn.error !== null || !Array.isArray(turn.items))
    throw Error('Interrupted native effects require a full error-free turn observation');
  const calls: HostCall[] = [];
  const ids = new Set<string>();
  for (const raw of turn.items) {
    const item = Item.parse(raw);
    if (ids.has(item.id)) throw Error('Interrupted native item identity is duplicated');
    ids.add(item.id);
    switch (item.type) {
      case 'userMessage':
      case 'agentMessage':
      case 'reasoning':
      case 'plan':
        break;
      case 'commandExecution':
        if (item.status !== 'completed' || item.exitCode !== 0)
          throw Error('Interrupted native command effects remain unknown');
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
        // File changes, MCP/collaboration and future native item types need
        // their own settlement contract. Never infer success from terminal turn metadata.
        throw Error('Interrupted native item effects are unsupported');
    }
  }
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
