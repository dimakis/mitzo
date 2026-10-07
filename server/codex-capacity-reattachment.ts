/** Manual-only readiness fence. No timer may start a provider transport here. */
export async function retryCapacityAfterReattachment(
  target: { recoveryId: string; sourceCommandId: string },
  deps: {
    read(): { id: string; sourceCommandId: string; revision: number } | undefined;
    reattach(): Promise<'ready' | 'reattaching' | 'unavailable'>;
    retry(): Promise<'queued' | 'unavailable'>;
  },
): Promise<'queued' | 'unavailable'> {
  const before = deps.read();
  if (
    !before ||
    before.id !== target.recoveryId ||
    before.sourceCommandId !== target.sourceCommandId
  )
    throw new Error('Capacity recovery changed');
  if ((await deps.reattach()) !== 'ready') return 'unavailable';
  const current = deps.read();
  if (
    !current ||
    current.id !== before.id ||
    current.sourceCommandId !== before.sourceCommandId ||
    current.revision !== before.revision
  )
    throw new Error('Capacity recovery changed during reattachment');
  return deps.retry();
}
