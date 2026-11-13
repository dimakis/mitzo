import { SessionLaunchRecordSchema, TelosCreateSessionInputSchema } from '@mitzo/protocol';
import { z } from 'zod';
import { toolInputError } from './tool-input-error.js';
import type { TelosToolResult } from './telos-tool.js';
import { retainTelosSessionProposalFailure } from './telos-session-proposal-failure.js';

/** Shared lightweight definition/transport; safe to import in the MCP process. */
export const telosSessionLaunchDefinition = {
  name: 'TelosCreateSession',
  description:
    'Propose a distinct ordinary session already assigned to one exact authorized Telos child. An outcome orchestrator creates its feature lead; a feature lead creates its slice worker. Supply itemId and its current revision. For reviewed adoption, also supply exact existingConversationId without overrides: the compatible idle Local Mac Codex chat keeps its settings, workspace and history; Approve & adopt never allocates a replacement. Otherwise review independent child settings and explicit sources, then Approve & create. Both operations admit no model command and confer no credentials or grants. Review occurs in this originating chat. Reuse the same requestId after uncertainty; do not substitute StartSession or manually link an unrelated chat.',
  input_schema: z.toJSONSchema(TelosCreateSessionInputSchema),
};
export const TelosSessionProposalResponseSchema = SessionLaunchRecordSchema.extend({
  handoverDownloadUrl: z.string().min(1).optional(),
  startupBlocker: z.string().optional(),
});

export async function executeTelosCreateSession(
  baseUrl: string,
  clientId: string,
  sessionId: string,
  token: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<TelosToolResult> {
  const parsed = TelosCreateSessionInputSchema.safeParse(raw);
  if (!parsed.success)
    return toolInputError(
      'Telos session creation input',
      TelosCreateSessionInputSchema,
      parsed.error,
    );
  if (!clientId || !sessionId || !token)
    return {
      content: 'Current authenticated ordinary caller required. Telos assignment is not confirmed.',
      isError: true,
    };
  try {
    const response = await fetch(`${baseUrl}/api/internal/telos/session/propose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': clientId,
        'X-Internal-Token': token,
      },
      body: JSON.stringify({ clientId, sessionId, input: parsed.data }),
      signal,
    });
    const body: unknown = await response.json();
    signal?.throwIfAborted();
    const record = TelosSessionProposalResponseSchema.safeParse(body);
    if (!response.ok) {
      const refusal = z.object({ error: z.string() }).safeParse(body);
      return {
        content: refusal.success
          ? refusal.data.error
          : 'Telos session proposal unavailable. Recover the original request.',
        isError: true,
      };
    }
    if (
      !record.success ||
      !record.data.telos ||
      record.data.sourceSessionId !== sessionId ||
      record.data.requestId !== parsed.data.requestId ||
      record.data.telos.itemId !== parsed.data.itemId ||
      record.data.telos.expectedRevision !== parsed.data.expectedRevision ||
      record.data.telos.adoption?.conversationId !== parsed.data.existingConversationId
    )
      return {
        content:
          'The retained response does not match the selected Telos work. Creation is not confirmed; recover the original request.',
        isError: true,
      };
    return { content: JSON.stringify(record.data), isError: false };
  } catch (cause) {
    retainTelosSessionProposalFailure(parsed.data.requestId, 'delivery', cause);
    return {
      content: JSON.stringify({
        code: signal?.aborted
          ? 'telos_session_proposal_delivery_cancelled'
          : 'telos_session_proposal_delivery_failed',
        stage: 'proposal_delivery',
        requestId: parsed.data.requestId,
        sourceSessionId: sessionId,
        effectStatus: 'unknown',
        message: signal?.aborted
          ? 'Telos session proposal delivery was cancelled. Inspect the original request before resuming; cancellation does not prove no proposal exists.'
          : 'Telos session proposal delivery is uncertain. Inspect or retry the same requestId and arguments; no assignment or model command is confirmed.',
      }),
      isError: true,
    };
  }
}
