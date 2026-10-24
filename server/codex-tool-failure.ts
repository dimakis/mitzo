import { randomUUID } from 'node:crypto';
import type { CodexToolResult } from './codex-tool-result.js';

export type ToolFailureCode =
  | 'cancelled'
  | 'approval_unavailable'
  | 'permission_denied'
  | 'stale_owner'
  | 'invalid_input'
  | 'internal_failure';

/** Fixed diagnostics only. Upstream messages, paths and credentials never enter the model result. */
export class CodexToolFailure extends Error {
  constructor(readonly code: ToolFailureCode) {
    super(code);
  }
}

export function codexToolFailureResult(error: unknown, aborted: boolean): CodexToolResult {
  const code: ToolFailureCode =
    aborted || (error instanceof Error && error.name === 'AbortError')
      ? 'cancelled'
      : error instanceof CodexToolFailure
        ? error.code
        : 'internal_failure';
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
      retry: 'after_reconciliation',
    }),
    isError: true,
  };
}
