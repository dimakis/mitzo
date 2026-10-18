import { z } from 'zod';
import type { ToolDefinition } from '@mitzo/harness';
import type { TelosToolResult } from './telos-tool.js';
import { toolInputError } from './tool-input-error.js';

const registrations = [
  {
    name: 'mcp__task-board__TaskStatus',
    operation: 'status',
    method: 'GET',
    schema: z.strictObject({}),
    description: 'Inspect only this exact delegated task and its progress.',
  },
  {
    name: 'mcp__task-board__TaskComplete',
    operation: 'complete',
    method: 'POST',
    schema: z.strictObject({ summary: z.string().trim().min(1).max(100_000) }),
    description:
      'Save the exact delegated task result and summary for pending_review. This is not verified outcome completion, acceptance, merge or deployment.',
  },
  {
    name: 'mcp__task-board__TaskBlock',
    operation: 'block',
    method: 'POST',
    schema: z.strictObject({ reason: z.string().trim().min(1).max(100_000) }),
    description: 'Record a blocker on this exact delegated task with its reason.',
  },
  {
    name: 'mcp__task-board__TaskArtifact',
    operation: 'artifact',
    method: 'POST',
    schema: z.strictObject({
      key: z.string().trim().min(1).max(200),
      value: z.string().max(100_000),
    }),
    description: 'Retain an attributed structured evidence reference on this exact delegated task.',
  },
] as const;
export const telosWorkerTaskDefinitions: ToolDefinition[] = registrations.map(
  ({ name, schema, description }) => ({ name, description, input_schema: z.toJSONSchema(schema) }),
);
export function telosWorkerTaskRegistration(name: string) {
  return registrations.find((registration) => registration.name === name);
}
export function isTelosWorkerTaskTool(name: string): boolean {
  return name.startsWith('mcp__task-board__');
}
/** Uses the existing task-tool owner, which derives task identity from the
 * current session and independently verifies its durable execution binding. */
export async function executeTelosWorkerTaskTool(
  baseUrl: string,
  clientId: string,
  expectedSessionId: string,
  expectedTaskId: string,
  token: string,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const registration = telosWorkerTaskRegistration(name);
  if (
    !registration ||
    !clientId.trim() ||
    !expectedSessionId.trim() ||
    !expectedTaskId.trim() ||
    !token.trim()
  )
    return {
      content: 'Exact delegated task tool and current client identity required',
      isError: true,
    };
  const parsed = registration.schema.safeParse(input);
  if (!parsed.success)
    return toolInputError('Delegated task input', registration.schema, parsed.error);
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${baseUrl}/api/internal/task-tools/${registration.operation}`, {
      method: registration.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'X-Client-Id': clientId,
        'X-Task-Session-Id': expectedSessionId,
        'X-Task-Id': expectedTaskId,
      },
      ...(registration.method === 'POST' ? { body: JSON.stringify(parsed.data) } : {}),
      signal,
    });
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    const result = z.strictObject({ result: z.string().min(1) }).safeParse(body);
    if (!response.ok || !result.success) {
      const error = z.object({ error: z.string() }).safeParse(body);
      return {
        content: error.success ? error.data.error : 'Delegated task update was not confirmed',
        isError: true,
      };
    }
    return { content: result.data.result, isError: /^Error:/i.test(result.data.result) };
  } catch {
    return {
      content:
        'Delegated task operation is uncertain; inspect its retained status before retrying. No task result receipt was received.',
      isError: true,
    };
  }
}
