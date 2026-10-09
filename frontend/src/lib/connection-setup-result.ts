import { z } from 'zod';
import { getToolStatus, type ToolBlock } from './tool-status';
const SetupResult = z.object({
  setup: z.object({
    id: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    status: z.enum(['pending', 'verifying', 'ready', 'cancelled', 'expired']),
    expiresAt: z.number().finite(),
    setupUrl: z.string(),
    connection: z.object({ label: z.string().min(1).max(100) }),
    credential: z.object({ label: z.string().min(1).max(100) }),
  }),
});
const setupTools = new Set([
  'PrepareConnectionSetup',
  'GetConnectionSetup',
  'mcp__mitzo-connections__PrepareConnectionSetup',
  'mcp__mitzo-connections__GetConnectionSetup',
]);
export function connectionSetupResult(block: ToolBlock, sessionId?: string) {
  if (
    !sessionId ||
    !setupTools.has(block.toolName ?? '') ||
    getToolStatus(block).hasError ||
    !block.toolResult
  )
    return null;
  try {
    const parsed = SetupResult.safeParse(JSON.parse(block.toolResult));
    if (!parsed.success) return null;
    const setup = parsed.data.setup;
    if (
      setup.sessionId !== sessionId ||
      setup.setupUrl !== `/connections/setup/${encodeURIComponent(setup.id)}`
    )
      return null;
    return setup;
  } catch {
    return null;
  }
}
