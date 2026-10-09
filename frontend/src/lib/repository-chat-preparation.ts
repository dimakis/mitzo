import { z } from 'zod';
import { getToolStatus, type ToolBlock } from './tool-status';

export const repositoryChatPreparationSchema = z
  .strictObject({
    id: z.uuid(),
    sourceConversationId: z.string().min(1).max(200),
    repository: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[a-z0-9._-]+\/[a-z0-9._-]+$/),
    baseBranch: z.string().min(1).max(1024),
    baseOid: z.string().regex(/^[a-f0-9]{40}$/),
    featureBranch: z.string().min(1).max(1024),
    state: z.enum(['preview', 'preparing', 'ready', 'claiming', 'claimed', 'failed', 'discarded']),
    accountId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(100000),
    setupUrl: z.string(),
    conversationId: z.string().min(1).max(200).optional(),
  })
  .refine((value) => value.setupUrl === `/chat?repositoryPreparation=${value.id}`)
  .refine((value) => value.state !== 'claimed' || !!value.conversationId);

export const repositoryChatPreparationResultSchema = z.strictObject({
  repositoryChat: repositoryChatPreparationSchema,
});
export type RepositoryChatPreparation = z.infer<typeof repositoryChatPreparationSchema>;
const tools = new Set([
  'PrepareRepositoryChat',
  'GetRepositoryChatPreparation',
  'mcp__mitzo-connections__PrepareRepositoryChat',
  'mcp__mitzo-connections__GetRepositoryChatPreparation',
]);

export function repositoryChatPreparationResult(block: ToolBlock, sessionId?: string) {
  if (
    !sessionId ||
    !tools.has(block.toolName ?? '') ||
    getToolStatus(block).hasError ||
    !block.toolResult
  )
    return null;
  try {
    const parsed = repositoryChatPreparationResultSchema.safeParse(JSON.parse(block.toolResult));
    return parsed.success && parsed.data.repositoryChat.sourceConversationId === sessionId
      ? parsed.data.repositoryChat
      : null;
  } catch {
    return null;
  }
}
