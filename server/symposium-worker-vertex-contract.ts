import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const WorkerVertexRequest = z.strictObject({
  method: z.literal('claude'),
  args: z.tuple([id]),
});
export const WorkerVertexReceipt = z.strictObject({
  principal: z.email().max(254),
  accountId: id,
  provider: id,
  providerId: id,
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  region: z.literal('global'),
  model: z.literal('claude-haiku-4-5@20251001'),
  workspace: id,
});
/** Only immutable public coordinates cross this channel. Unknown keys, including
 * credential material, are rejected rather than projected into workerData. */
export function parseWorkerVertexReceipt(value: unknown) {
  const parsed = WorkerVertexReceipt.safeParse(value);
  if (!parsed.success) throw Error('Evidence provider receipt unavailable');
  return Object.freeze(parsed.data);
}
