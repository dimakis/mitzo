import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CodexToolResult } from './codex-tool-result.js';

export type ToolFailureCode =
  | 'cancelled'
  | 'approval_unavailable'
  | 'permission_denied'
  | 'stale_owner'
  | 'invalid_input'
  | 'internal_failure';

export const CodexToolFailureDiagnosticSchema = z.strictObject({
  stage: z.enum([
    'tool_execution',
    'repository_preparation',
    'workspace_transition',
    'publication',
  ]),
  reason: z.enum([
    'unknown',
    'cancelled',
    'approval_unavailable',
    'filesystem_denied',
    'deadline',
    'storage_full',
    'custody_changed',
    'missing_connection',
    'invalid_input',
  ]),
  effectStatus: z.enum(['not_started', 'unknown', 'completed']),
});
export type CodexToolFailureDiagnostic = z.infer<typeof CodexToolFailureDiagnosticSchema>;
export const CodexDiagnosticIdentitySchema = z.strictObject({
  commandId: z.string().min(1).max(200),
  attempt: z.number().int().positive().safe(),
  callId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().safe(),
  release: z.string().min(1).max(200),
  nativeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  workspaceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
});

/** Fixed diagnostics only. Upstream messages, paths and credentials never enter the model result. */
export class CodexToolFailure extends Error {
  constructor(
    readonly code: ToolFailureCode,
    readonly diagnostic?: CodexToolFailureDiagnostic,
  ) {
    super(code);
    if (diagnostic)
      this.diagnostic = Object.freeze(CodexToolFailureDiagnosticSchema.parse(diagnostic));
  }
}

export function codexToolFailureResult(
  error: unknown,
  aborted: boolean,
  identity?: z.infer<typeof CodexDiagnosticIdentitySchema>,
): CodexToolResult {
  const code: ToolFailureCode =
    aborted || (error instanceof Error && error.name === 'AbortError')
      ? 'cancelled'
      : error instanceof CodexToolFailure
        ? error.code
        : 'internal_failure';
  const resourceCode = error instanceof Error && 'code' in error ? error.code : undefined;
  const reason: CodexToolFailureDiagnostic['reason'] =
    code === 'cancelled'
      ? 'cancelled'
      : resourceCode === 'EACCES' || resourceCode === 'EPERM'
        ? 'filesystem_denied'
        : resourceCode === 'ETIMEDOUT'
          ? 'deadline'
          : resourceCode === 'ENOSPC' || resourceCode === 'SQLITE_FULL'
            ? 'storage_full'
            : code === 'stale_owner'
              ? 'custody_changed'
              : code === 'approval_unavailable'
                ? 'approval_unavailable'
                : code === 'invalid_input'
                  ? 'invalid_input'
                  : 'unknown';
  const diagnostic = {
    ...(error instanceof CodexToolFailure && error.diagnostic
      ? error.diagnostic
      : { stage: 'tool_execution', reason, effectStatus: 'unknown' }),
    ...(identity ? CodexDiagnosticIdentitySchema.parse(identity) : {}),
  };
  const actions: Record<ToolFailureCode, string> = {
    approval_unavailable:
      'Execution was not approved. Resolve the reported approval/session condition before requesting another approval.',
    cancelled:
      'The call was cancelled. Inspect current state before resuming; an effect may already have happened.',
    permission_denied:
      'Permission was denied. Do not retry or use another route unless the user or permission state changes.',
    stale_owner:
      'The admitted owner or repository binding changed. Reconcile the current session/workspace before another call.',
    invalid_input: 'Read the tool contract and correct the arguments before another call.',
    internal_failure:
      'The outcome is uncertain. Inspect current state and the diagnostic reference before retrying; do not repeat a write blindly.',
  };
  return {
    content: JSON.stringify({
      error: code,
      action: actions[code],
      diagnosticId: randomUUID(),
      diagnostic,
      retry: 'after_reconciliation',
    }),
    isError: true,
  };
}
