import { z } from 'zod';
import {
  TelosSourcePermissionReceiptSchema,
  TelosSourcePermissionOperationSchema,
  type TelosSourcePermissionReceipt,
  type TelosSourcePermissionOperation,
} from '@mitzo/protocol';
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

export interface TelosToolResult {
  content: string;
  isError: boolean;
}

/** Provider execution retrieves an operator-approved receipt; it cannot create. */
export const TELOS_ADOPT_SOURCE_TOOL = 'TelosAdoptSource';
export const TelosAdoptSourceInput = z.strictObject({ itemId: z.string().trim().min(1).max(200) });
export const telosAdoptSourceDefinition: ToolDefinition = {
  name: TELOS_ADOPT_SOURCE_TOOL,
  description:
    'Attach an explicitly reviewed original exchange and retained materials to one exact existing Telos item. The operator selects and approves the source; this never changes progress or assigns/starts a worker.',
  input_schema: z.toJSONSchema(TelosAdoptSourceInput),
};
export const telosApprovalExecutionField = {
  __mitzoTelosApproval: z
    .uuid()
    .optional()
    .describe('Reserved host approval receipt; never supply this field.'),
};
export function formatTelosSourceResult(
  result: TelosSourcePermissionReceipt & { operation: TelosSourcePermissionOperation },
): TelosToolResult {
  const itemId = result.receipt.work.itemId;
  if (
    result.operation.kind === 'create' &&
    (!result.canonicalCreation || result.canonicalCreation.item.id !== itemId)
  )
    return {
      content: 'Actual canonical creation receipt unavailable; creation not confirmed.',
      isError: true,
    };
  return {
    content: JSON.stringify({
      ...(result.operation.kind === 'create'
        ? {
            created: result.canonicalCreation!.created,
            canonicalCreation: result.canonicalCreation,
          }
        : { adopted: true }),
      id: itemId,
      title:
        result.operation.kind === 'create'
          ? result.operation.outcome.summary
          : 'Reviewed source saved',
      path: '/todos/' + encodeURIComponent(itemId),
      sourceSnapshotId: result.sourceSnapshotId,
    }),
    isError: false,
  };
}
async function executeReviewedSource(
  baseUrl: string,
  clientId: string,
  token: string,
  input: unknown,
  operation: 'create' | 'adopt',
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const schema = operation === 'create' ? TelosOutcomeInput : TelosAdoptSourceInput;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { content: 'Invalid Telos input', isError: true };
  const { __mitzoTelosApproval, ...proposal } = input as Record<string, unknown>;
  const parsed = schema.safeParse(proposal);
  if (!parsed.success) return toolInputError('Telos source input', schema, parsed.error);
  if (!z.uuid().safeParse(__mitzoTelosApproval).success)
    return {
      content:
        'A host-injected reviewed source approval receipt is required; request approval again.',
      isError: true,
    };
  try {
    const response = await fetch(baseUrl + '/api/internal/telos/source/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        'X-Client-Id': clientId,
      },
      body: JSON.stringify({
        approvalReceiptId: __mitzoTelosApproval,
        proposal: parsed.data,
        operation,
      }),
      signal,
    });
    const body: unknown = await response.json();
    const result = TelosSourcePermissionReceiptSchema.extend({
      operation: TelosSourcePermissionOperationSchema,
    }).safeParse(body);
    if (!response.ok || !result.success) {
      const failure = z.object({ error: z.string() }).safeParse(body);
      return {
        content: failure.success
          ? failure.data.error
          : 'Reviewed Telos receipt unavailable; save not confirmed.',
        isError: true,
      };
    }
    if (result.data.operation.kind !== operation)
      return { content: 'Reviewed Telos operation differs; save not confirmed.', isError: true };
    return formatTelosSourceResult(result.data);
  } catch {
    return {
      content:
        'Reviewed Telos receipt unavailable. Retry the exact original invocation to recover its receipt.',
      isError: true,
    };
  }
}
export function executeTelosCreateOutcome(
  baseUrl: string,
  clientId: string,
  token: string,
  input: unknown,
  signal?: AbortSignal,
) {
  return executeReviewedSource(baseUrl, clientId, token, input, 'create', signal);
}
export function executeTelosAdoptSource(
  baseUrl: string,
  clientId: string,
  token: string,
  input: unknown,
  signal?: AbortSignal,
) {
  return executeReviewedSource(baseUrl, clientId, token, input, 'adopt', signal);
}
