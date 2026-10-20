import { z } from 'zod';
import type { ToolDefinition } from '@mitzo/harness';
import { TelosWorkControlResultSchema, TelosWorkControlToolInputSchema } from '@mitzo/protocol';
import type { TelosToolResult } from './telos-tool.js';
import { toolInputError } from './tool-input-error.js';
export const TELOS_WORK_CONTROL_TOOL = 'TelosWorkControl';
export const telosWorkControlDefinitions: ToolDefinition[] = [
  {
    name: TELOS_WORK_CONTROL_TOOL,
    description:
      'Inspect your current scoped coordination inbox, acknowledge receipt, or (as the current coordinator) request/release an exact hold through attached outcome leads. Publication, new worker dispatch and safe point are distinct. Acknowledgement is not application. Preserve requestId on uncertain delivery. This sends no model turn, interrupt or abort; host evidence and publication revalidation cannot be supplied by this tool.',
    input_schema: z.toJSONSchema(TelosWorkControlToolInputSchema),
  },
];
export async function executeTelosWorkControlTool(
  baseUrl: string,
  clientId: string,
  sessionId: string,
  token: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const parsed = TelosWorkControlToolInputSchema.safeParse(raw);
  if (!parsed.success)
    return toolInputError('Scoped work control', TelosWorkControlToolInputSchema, parsed.error);
  if (![clientId, sessionId, token].every((v) => v.trim()))
    return { content: 'Exact current ordinary conversation required', isError: true };
  const input = parsed.data.command;
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${baseUrl}/api/internal/telos/work/control`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'X-Client-Id': clientId,
      },
      body: JSON.stringify({ clientId, sessionId, input }),
      signal,
    });
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    const result = TelosWorkControlResultSchema.safeParse(body);
    if (!response.ok || !result.success) {
      const error = z.object({ error: z.string() }).safeParse(body);
      return {
        content: error.success ? error.data.error : 'Scoped control receipt was not confirmed',
        isError: true,
      };
    }
    if ((input.operation === 'inbox') !== Array.isArray(result.data))
      return {
        content: 'Scoped control receipt differs from the selected operation',
        isError: true,
      };
    if (!Array.isArray(result.data)) {
      if (
        input.operation === 'request'
          ? result.data.coordinatorItemId !== input.coordinatorItemId ||
            result.data.priorityItemId !== input.priorityItemId ||
            result.data.scope !== input.scope
          : 'controlId' in input && result.data.controlId !== input.controlId
      )
        return {
          content: 'Scoped control receipt differs from the selected request',
          isError: true,
        };
    }
    return { content: JSON.stringify(result.data), isError: false };
  } catch {
    return {
      content:
        'Scoped control delivery is uncertain; inspect the inbox and reuse the original requestId. No application or release acknowledgement was confirmed.',
      isError: true,
    };
  }
}
