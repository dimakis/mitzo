/** PRIVATE preparation read-stage policy only. An earlier actual overall or
 * consumed-evidence deadline narrows it; no root, grant or owner is supplied. */
export const preparationReadStageMs = 60000;
const unavailable = () => Error('Preparation read deadline unavailable');
export function preparationReadDeadline(deadline: number, signal: AbortSignal): number {
  signal.throwIfAborted();
  const now = Date.now();
  if ((deadline !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(deadline)) || deadline <= now)
    throw unavailable();
  return Math.min(deadline, now + preparationReadStageMs);
}
/** Individual private Git processes retain the existing thirty-second cap. */
export function preparationCommandTimeout(deadline: number, signal?: AbortSignal): number {
  signal?.throwIfAborted();
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(deadline) || remaining <= 0) throw unavailable();
  return Math.min(30000, remaining);
}
