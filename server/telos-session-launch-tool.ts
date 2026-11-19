import { SessionLaunchRecordSchema, TelosCreateSessionInputSchema } from '@mitzo/protocol';
import { z } from 'zod';
import { toolInputError } from './tool-input-error.js';
import type { TelosToolResult } from './telos-tool.js';
import { retainTelosSessionProposalFailure } from './telos-session-proposal-failure.js';

/** Shared lightweight definition/transport; safe to import in the MCP process. */
export const telosSessionLaunchDefinition = {
  name: 'TelosCreateSession',
  description:
    'Propose an operator-reviewed Telos session assignment. A current outcome orchestrator creates its feature lead; a current feature lead creates its slice worker. Supply the exact child itemId and current revision. For initial adoption, also supply existingConversationId without overrides. To replace a current orchestrator, feature lead or slice owner, set replaceOwner:true, select the owned item itself and exact existingConversationId (which may be this originating chat). Any available ordinary chat may propose replacement; only Approve & replace owner commits it. The compatible idle Local Mac Codex or Claude target keeps its engine, settings, workspace and history; former attribution and original operations remain. Busy, OpenShell or other-operator chats are refused with a named reason (existing_chat_busy, existing_chat_openshell, existing_chat_foreign_operator, existing_chat_incompatible). New children are created only on Local Mac Codex. Adoption allocates no replacement chat. Creation uses independently reviewed settings and sources. Neither approval admits a model command or transfers credentials or grants. Review occurs in this originating chat. Reuse the same requestId after uncertainty; do not substitute StartSession or fabricate assignment by editing a brief.',
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
      record.data.telos.adoption?.conversationId !== parsed.data.existingConversationId ||
      Boolean(record.data.telos.replacement) !== Boolean(parsed.data.replaceOwner)
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
