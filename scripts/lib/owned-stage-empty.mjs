import { z } from 'zod';
const row = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  label: z.string().trim().min(1).max(120),
  revision: z.number().int().positive(),
  state: z.literal('disconnected'),
});
/** Refuse existing conversation history or any partially provisioned account.
 * This is an initial-stage eligibility check, never retirement authority. */
export function assertInitialStagingFacts(eventCounts, taskCounts, connections) {
  if (
    !Array.isArray(eventCounts) ||
    eventCounts.length !== 6 ||
    eventCounts.some((n) => n !== 0) ||
    !Array.isArray(taskCounts) ||
    taskCounts.length !== 1 ||
    taskCounts.some((n) => n !== 0)
  )
    throw Error('Conversation, events, tasks or native membership prevent initial fresh update');
  const rows = z.array(row).max(100).parse(connections);
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw Error('Duplicate Personal metadata');
}
