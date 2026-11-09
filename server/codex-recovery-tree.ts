import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { SessionRuntimeError } from './session-runtime-error.js';

const Thread = z.object({
  id: z.string().min(1),
  parentThreadId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  modelProvider: z.string().min(1),
  status: z.object({ type: z.enum(['notLoaded', 'idle']) }),
});
const Turn = z.object({
  id: z.string().min(1),
  status: z.enum(['completed', 'interrupted', 'failed']),
  error: z.null(),
});
const Turns = z.object({
  data: z.array(Turn).max(1),
  nextCursor: z.string().min(1).max(4096).nullable(),
});

/** Activities are references, not completion or parentage evidence. Verify the
 * actual tree and every retained child turn. Reads share the caller's I/O budget
 * and current authority; this never attaches, resumes or cancels a child. */
export async function inspectNativeRecoveryTree(
  rootId: string,
  expectedCwd: string | undefined,
  references: Set<string>,
  read: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  inspectItems: (threadId: string, turnId: string) => Promise<void>,
): Promise<void> {
  if (!references.size) return;
  const readThread = async (id: string) => {
    const result = z
      .object({ thread: Thread })
      .parse(await read('thread/read', { threadId: id, includeTurns: false })).thread;
    if (result.id !== id) throw new SessionRuntimeError('provider_identity');
    return result;
  };
  const root = await readThread(rootId);
  if (root.parentThreadId !== null || root.cwd !== expectedCwd)
    throw new SessionRuntimeError('provider_identity');
  const threads = new Map([[rootId, root]]);
  const visiting = new Set<string>();
  const qualify = async (id: string): Promise<void> => {
    if (threads.has(id)) return;
    if (threads.size + visiting.size >= 32) throw new SessionRuntimeError('recovery_history_limit');
    if (visiting.has(id)) throw new SessionRuntimeError('provider_identity');
    visiting.add(id);
    const thread = await readThread(id);
    if (
      !thread.parentThreadId ||
      thread.sessionId !== root.sessionId ||
      thread.cwd !== root.cwd ||
      thread.modelProvider !== root.modelProvider
    )
      throw new SessionRuntimeError('provider_identity');
    await qualify(thread.parentThreadId);
    references.add(thread.parentThreadId);
    threads.set(id, thread);
    visiting.delete(id);
  };
  const latest = new Map<string, z.infer<typeof Turn>>();
  // Iteration includes references discovered in earlier child turns, including
  // ancestors and siblings. Qualified identities are deduplicated, not revisited.
  for (const id of references) {
    await qualify(id);
    if (id === rootId || latest.has(id)) continue;
    const cursors = new Set<string>();
    const turns = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = Turns.parse(
        await read('thread/turns/list', {
          threadId: id,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
          ...(cursor ? { cursor } : {}),
        }),
      );
      const turn = page.data[0];
      if (!turn || turns.has(turn.id)) throw new SessionRuntimeError('recovery_effects_unverified');
      turns.add(turn.id);
      if (!latest.has(id)) latest.set(id, turn);
      await inspectItems(id, turn.id);
      if (page.nextCursor === null) break;
      if (cursors.has(page.nextCursor))
        throw new SessionRuntimeError('recovery_effects_unverified');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  for (const [id, original] of threads) {
    if (!isDeepStrictEqual(await readThread(id), original))
      throw new SessionRuntimeError('provider_identity');
    if (id === rootId) continue; // The caller rechecks the exact original root terminal last.
    const page = Turns.parse(
      await read('thread/turns/list', {
        threadId: id,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      }),
    );
    if (page.data.length !== 1 || !isDeepStrictEqual(page.data[0], latest.get(id)))
      throw new SessionRuntimeError('provider_identity');
  }
}
