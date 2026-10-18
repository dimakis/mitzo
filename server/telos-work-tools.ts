import { z } from 'zod';
import { TelosStartSliceInputSchema, TelosWorkDelegationReceiptSchema } from '@mitzo/protocol';
import type { ToolDefinition } from '@mitzo/harness';
import type { TelosToolResult } from './telos-tool.js';
import { toolInputError } from './tool-input-error.js';

export { TelosStartSliceInputSchema };
export const TELOS_START_SLICE_TOOL = 'TelosStartSlice';
export const telosWorkDefinitions: ToolDefinition[] = [
  {
    name: TELOS_START_SLICE_TOOL,
    description:
      'Allocate or recover one ordinary worker chat for the exact explicitly selected child of this lead. Returns its retained worker link while staying in the lead chat; does not start a model turn or complete work. Use start to recover existing work; retry requires an explicit user request and the exact predecessor attempt. Reuse requestId after uncertain responses. Never guess an ambiguous child or start siblings.',
    input_schema: z.toJSONSchema(TelosStartSliceInputSchema),
  },
];

/** Shared native/MCP transport. The route rechecks the exact live lead owner. */
export async function executeTelosWorkTool(
  baseUrl: string,
  clientId: string,
  sessionId: string,
  token: string,
  name: typeof TELOS_START_SLICE_TOOL,
  input: unknown,
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const parsed = TelosStartSliceInputSchema.safeParse(input);
  if (!parsed.success)
    return toolInputError('Telos delegation input', TelosStartSliceInputSchema, parsed.error);
  if (name !== TELOS_START_SLICE_TOOL || !clientId.trim() || !sessionId.trim() || !token.trim())
    return {
      content: 'Exact current Telos lead client and session identity required',
      isError: true,
    };
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${baseUrl}/api/internal/telos/work/delegate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'X-Client-Id': clientId,
      },
      body: JSON.stringify({ clientId, sessionId, input: parsed.data }),
      signal,
    });
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    const receipt = TelosWorkDelegationReceiptSchema.safeParse(body);
    if (!response.ok || !receipt.success) {
      const error = z.object({ error: z.string() }).safeParse(body);
      return {
        content: error.success
          ? error.data.error
          : 'Telos worker allocation was not confirmed; retry the same requestId to recover its receipt',
        isError: true,
      };
    }
    const result = receipt.data;
    if (
      result.attempt.state !== 'chat_ready' ||
      result.attempt.childItemId !== parsed.data.childItemId ||
      result.attempt.leadConversationId !== sessionId ||
      result.attempt.workerConversationId !== result.workerConversationId ||
      result.workerConversationId === sessionId ||
      result.attempt.turnCommandId !== null ||
      result.workerPath !== `/chat/${encodeURIComponent(result.workerConversationId)}` ||
      result.itemPath !== `/todos/${encodeURIComponent(parsed.data.childItemId)}` ||
      result.leadPath !== `/chat/${encodeURIComponent(sessionId)}`
    )
      return {
        content:
          'Telos worker receipt does not match the exact selected child and lead; allocation not confirmed',
        isError: true,
      };
    return { content: JSON.stringify(result), isError: false };
  } catch {
    return {
      content:
        'Telos worker allocation is uncertain; retry the same requestId to recover its receipt. No execution receipt was received.',
      isError: true,
    };
  }
}
