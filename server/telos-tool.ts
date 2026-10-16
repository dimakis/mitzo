import { z } from 'zod';
import { toolInputError } from './tool-input-error.js';
import type { ToolDefinition } from '@mitzo/harness';

export const TELOS_CREATE_OUTCOME_TOOL = 'TelosCreateOutcome';

export const telosOutcomeShape = {
  summary: z.string().trim().min(1).max(160).describe('Short, scannable outcome title'),
  intent: z.string().trim().min(1).max(2000).describe('What will be true when achieved'),
  rationale: z.string().trim().min(1).max(2000).describe('Why the outcome matters'),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(12)
    .describe('Observable evidence that proves completion'),
  milestones: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(24)
    .describe('Ordered milestones; the first unfinished entry is the next action'),
  profile: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      'Exact configured Telos processing profile, not an AI account, model or project. If rejected, use one of the profile names returned by the host.',
    ),
  contextHints: z
    .object({
      repos: z.array(z.string()).optional(),
      paths: z.array(z.string()).optional(),
      issues: z.array(z.string()).optional(),
      docIds: z.array(z.string()).optional(),
      people: z.array(z.string()).optional(),
      jiraKeys: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      taskHint: z.string().optional(),
    })
    .optional(),
  links: z
    .array(
      z.object({
        type: z.string(),
        url: z.string(),
        title: z.string(),
        description: z.string().optional(),
      }),
    )
    .max(24)
    .optional(),
};

export const TelosOutcomeInput = z.object(telosOutcomeShape).strict();
export type TelosOutcomeInput = z.infer<typeof TelosOutcomeInput>;

export const telosCreateOutcomeDefinition: ToolDefinition = {
  name: TELOS_CREATE_OUTCOME_TOOL,
  description:
    'Create one durable outcome in live Telos with an explicit result, rationale, evidence criteria, and ordered milestones. Use this instead of running sandbox-local todo scripts. This mutates Telos and requires user approval.',
  input_schema: z.toJSONSchema(TelosOutcomeInput),
};

const TelosOutcomeResponse = z
  .object({
    ok: z.boolean().optional(),
    error: z.string().optional(),
    created: z.boolean().optional(),
    item: z
      .object({
        id: z.string().optional(),
        summary: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const TelosOutcomeReceipt = z.object({
  ok: z.literal(true),
  created: z.boolean(),
  item: z.object({ id: z.string().min(1), summary: z.string().min(1) }),
});

export interface TelosToolResult {
  content: string;
  isError: boolean;
}

/** Execute through Mitzo's trusted host API. No host credential enters the sandbox. */
export async function executeTelosCreateOutcome(
  baseUrl: string,
  clientId: string,
  token: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const parsedInput = TelosOutcomeInput.safeParse(input);
  if (!parsedInput.success)
    return toolInputError('Telos outcome input', TelosOutcomeInput, parsedInput.error);

  try {
    const response = await fetch(`${baseUrl}/api/internal/telos/outcomes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'X-Client-Id': clientId,
      },
      body: JSON.stringify(parsedInput.data),
      signal,
    });
    const parsedResult = TelosOutcomeResponse.safeParse(await response.json());
    if (!parsedResult.success)
      return { content: 'Live Telos returned an invalid response', isError: true };
    const result = parsedResult.data;
    if (!response.ok || result.ok === false)
      return {
        content: result.error ?? `Live Telos request failed with HTTP ${response.status}`,
        isError: true,
      };
    const receipt = TelosOutcomeReceipt.safeParse(result);
    if (!receipt.success)
      return {
        content: 'Live Telos returned no confirmed outcome receipt; creation not confirmed',
        isError: true,
      };
    return {
      content: JSON.stringify({
        created: receipt.data.created,
        id: receipt.data.item.id,
        title: receipt.data.item.summary,
        path: `/todos/${receipt.data.item.id}`,
      }),
      isError: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Live Telos request failed: ${message}`, isError: true };
  }
}
