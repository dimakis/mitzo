import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PendingHostTaskError } from './pending-host-task.js';
import type { CodexToolResult } from './codex-tool-result.js';

export type ToolFailureCode =
  | 'cancelled'
  | 'approval_unavailable'
  | 'permission_denied'
  | 'stale_owner'
  | 'invalid_input'
  | 'internal_failure';

const FailureDetailSchema = z.strictObject({
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
export const CodexToolFailureDiagnosticSchema = FailureDetailSchema.extend({
  primary: FailureDetailSchema.optional(),
  cleanup: z.array(FailureDetailSchema).max(8).optional(),
  cleanupTruncated: z.literal(true).optional(),
});
export type CodexToolFailureDiagnostic = z.infer<typeof CodexToolFailureDiagnosticSchema>;
type FailureDetail = z.infer<typeof FailureDetailSchema>;

class ToolCleanupFailure extends AggregateError {
  constructor(
    readonly primary: { error: unknown } | undefined,
    readonly cleanupFailures: readonly unknown[],
  ) {
    super(cleanupFailures, 'Tool cleanup failed', primary ? { cause: primary.error } : {});
  }
}

/** Join every resource cleanup and final fence, even after another fails. */
export async function withCodexToolCleanup<T>(
  action: () => Promise<T>,
  cleanups: readonly (() => unknown | Promise<unknown>)[],
): Promise<T> {
  let value!: T;
  let primary: { error: unknown } | undefined;
  try {
    value = await action();
  } catch (error) {
    primary = { error };
  }
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new ToolCleanupFailure(primary, Object.freeze(failures));
  if (primary) throw primary.error;
  return value;
}

export const CodexDiagnosticIdentitySchema = z.strictObject({
  commandId: z.string().min(1).max(200),
  attempt: z.number().int().positive().safe(),
  callId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(200),
  generation: z.number().int().nonnegative().safe(),
  release: z.string().min(1).max(200),
  releaseRevision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  nativeArtifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  runtimeBindingRevision: z.string().min(1).max(200).optional(),
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

function failureProjection(
  error: unknown,
  stage: FailureDetail['stage'],
  depth = 0,
): { code: ToolFailureCode; diagnostic: CodexToolFailureDiagnostic } {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let cause = error;
  for (let depth = 0; depth < 8 && cause instanceof Error && !seen.has(cause); depth++) {
    chain.push(cause);
    seen.add(cause);
    cause = cause.cause;
  }
  const cleanup = chain.find((failure) => failure instanceof ToolCleanupFailure);
  if (cleanup && depth < 8) {
    const original = cleanup.primary
      ? failureProjection(cleanup.primary.error, stage, depth + 1)
      : undefined;
    const failures = cleanup.cleanupFailures.map((failure) =>
      failureProjection(failure, stage, depth + 1),
    );
    const projections = [...(original ? [original] : []), ...failures];
    const refusal =
      projections.find((item) => item.code === 'cancelled') ??
      projections.find((item) => item.code === 'stale_owner') ??
      projections.find((item) => item.code === 'permission_denied');
    const selected = refusal ?? original ?? failures[0];
    const details = [
      ...(original?.diagnostic.cleanup ?? []),
      ...failures.flatMap((item) =>
        item.diagnostic.cleanup
          ? [
              ...(item.diagnostic.primary
                ? [{ ...item.diagnostic.primary, effectStatus: 'unknown' as const }]
                : []),
              ...item.diagnostic.cleanup,
            ]
          : [
              FailureDetailSchema.parse({
                stage: item.diagnostic.stage,
                reason: item.diagnostic.reason,
                effectStatus: 'unknown',
              }),
            ],
      ),
    ];
    return {
      code: selected.code,
      diagnostic: {
        stage: selected.diagnostic.stage,
        reason: selected.diagnostic.reason,
        effectStatus: 'unknown',
        ...(original
          ? {
              primary:
                original.diagnostic.primary ??
                FailureDetailSchema.parse({
                  stage: original.diagnostic.stage,
                  reason: original.diagnostic.reason,
                  effectStatus: original.diagnostic.effectStatus,
                }),
            }
          : {}),
        cleanup: details.slice(0, 8),
        ...(details.length > 8 || projections.some((item) => item.diagnostic.cleanupTruncated)
          ? { cleanupTruncated: true as const }
          : {}),
      },
    };
  }
  const typed = chain.find((failure) => failure instanceof CodexToolFailure);
  const boundary = chain.find((failure) => failure instanceof PendingHostTaskError);
  const code: ToolFailureCode = chain.some((failure) => failure.name === 'AbortError')
    ? 'cancelled'
    : (typed?.code ??
      (boundary?.code === 'pending_host_task_ownership_changed'
        ? 'stale_owner'
        : boundary?.code === 'pending_host_task_invalid_input'
          ? 'invalid_input'
          : 'internal_failure'));
  const resourceCode = chain
    .map((failure) => ('code' in failure ? failure.code : undefined))
    .find((value) =>
      ['EACCES', 'EPERM', 'ETIMEDOUT', 'ENOSPC', 'SQLITE_FULL'].includes(value as string),
    );
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
  const diagnostic = typed?.diagnostic ?? {
    stage: boundary ? ('repository_preparation' as const) : stage,
    reason,
    effectStatus: 'unknown' as const,
  };
  return {
    code,
    diagnostic: code === 'cancelled' ? { ...diagnostic, reason: 'cancelled' } : diagnostic,
  };
}

export function codexToolFailureResult(
  error: unknown,
  aborted: boolean,
  identity?: z.infer<typeof CodexDiagnosticIdentitySchema>,
  stage: CodexToolFailureDiagnostic['stage'] = 'tool_execution',
): CodexToolResult {
  const projected = failureProjection(error, stage);
  const code = aborted ? 'cancelled' : projected.code;
  const checkedIdentity = CodexDiagnosticIdentitySchema.safeParse(identity);
  const diagnostic = {
    ...projected.diagnostic,
    ...(aborted ? { reason: 'cancelled' as const } : {}),
    ...(checkedIdentity.success ? checkedIdentity.data : {}),
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
