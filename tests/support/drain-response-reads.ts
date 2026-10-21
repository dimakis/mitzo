/** Finish every queued observer body read before closing its browser owner.
 * More response callbacks can enqueue reads while an earlier body is pending.
 * Errors propagate; this fence never supplies, discards or rewrites a response.
 */
export async function drainResponseReads(reads: readonly Promise<void>[]): Promise<void> {
  let settled = 0;
  while (settled < reads.length) {
    const end = reads.length;
    await Promise.all(reads.slice(settled, end));
    settled = end;
  }
}
