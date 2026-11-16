import { z } from 'zod';

/** A projection change, never deletion of the original event or tool effect. */
export const MessageRetractionSchema = z.object({
  messageId: z.string().min(1).max(2000),
  toolId: z.string().min(1).max(1000).optional(),
});
export type MessageRetraction = z.infer<typeof MessageRetractionSchema>;
export const RETRACTED_TOOL_RESULT = 'The provider retracted this result.';

interface RetractableBlock {
  blockType?: string;
  toolId?: string;
  toolResult?: string;
  toolError?: boolean;
  toolResultImages?: unknown;
}

export function retractToolResult<T extends RetractableBlock>(block: T): T {
  const { toolResultImages: _images, toolError: _error, ...retained } = block;
  return { ...retained, toolResult: RETRACTED_TOOL_RESULT } as T;
}

/** Ordinary assistant projections only; user inputs and attributed seats survive. */
export function projectMessageRetractions<
  T extends {
    messageId: string;
    role?: string;
    symposiumProvenance?: unknown;
    agentMessage?: unknown;
    blocks: RetractableBlock[];
  },
>(messages: T[], retractions: readonly MessageRetraction[]): T[] {
  const removed = new Set(retractions.filter((r) => !r.toolId).map((r) => r.messageId));
  const tools = new Set(
    retractions.filter((r) => r.toolId).map((r) => JSON.stringify([r.messageId, r.toolId])),
  );
  return messages.flatMap((m) => {
    if (m.role === 'user' || m.symposiumProvenance || m.agentMessage) return [m];
    // Provider replacement never erases already-known host tool/child activity.
    // Its response text/thinking is removed; the original event prefix stays intact.
    const retained = removed.has(m.messageId)
      ? m.blocks.filter((block) => block.blockType === 'tool_use')
      : m.blocks;
    if (!retained.length && removed.has(m.messageId)) return [];
    let changed = false;
    const blocks = retained.map((block) => {
      if (!block.toolId || !tools.has(JSON.stringify([m.messageId, block.toolId]))) return block;
      changed = true;
      return retractToolResult(block);
    });
    return [changed || retained !== m.blocks ? { ...m, blocks } : m];
  });
}
