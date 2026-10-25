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
const RelayResult = z.object({
  relay: z.object({
    id: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    status: z.enum(['pending', 'verifying', 'ready', 'cancelled', 'expired', 'unconfirmed']),
    expiresAt: z.number().finite(),
    setupUrl: z.string(),
    label: z.string().min(1).max(100),
  }),
});
const relayTools = new Set([
  'PrepareSecretRelay',
  'GetSecretRelay',
  'mcp__mitzo-connections__PrepareSecretRelay',
  'mcp__mitzo-connections__GetSecretRelay',
]);
const setupTools = new Set([
  'PrepareConnectionSetup',
  'GetConnectionSetup',
  'mcp__mitzo-connections__PrepareConnectionSetup',
  'mcp__mitzo-connections__GetConnectionSetup',
]);
export function connectionSetupResult(block: ToolBlock, sessionId?: string) {
  if (
    !sessionId ||
    (!setupTools.has(block.toolName ?? '') && !relayTools.has(block.toolName ?? '')) ||
    getToolStatus(block).hasError ||
    !block.toolResult
  )
    return null;
  try {
    if (relayTools.has(block.toolName ?? '')) {
      const parsed = RelayResult.safeParse(JSON.parse(block.toolResult));
      if (!parsed.success) return null;
      const relay = parsed.data.relay;
      if (
        relay.sessionId !== sessionId ||
        relay.setupUrl !== `/connections/secrets/${encodeURIComponent(relay.id)}`
      )
        return null;
      return {
        ...relay,
        kind: 'relay' as const,
        connection: { label: relay.label },
        credential: { label: 'password or token' },
      };
    }
    const parsed = SetupResult.safeParse(JSON.parse(block.toolResult));
    if (!parsed.success) return null;
    const setup = parsed.data.setup;
    if (
      setup.sessionId !== sessionId ||
      setup.setupUrl !== `/connections/setup/${encodeURIComponent(setup.id)}`
    )
      return null;
    return { ...setup, kind: 'connection' as const };
  } catch {
    return null;
  }
}
