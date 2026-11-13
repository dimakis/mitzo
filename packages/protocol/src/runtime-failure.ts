import { z } from 'zod';

export const KNOWLEDGE_RUNTIME_UNAVAILABLE_MESSAGE =
  'Current knowledge could not be prepared for this runtime. Check the knowledge publisher and release a compatible runtime before retrying. Your draft and conversation are retained.';

/** Reviewed public copy only. Both producers and consumers use this allowlist;
 * upstream exceptions and saved device text never supply a diagnostic message. */
export const SESSION_RUNTIME_MESSAGES = {
  telos_work_context_changed:
    'The reviewed Telos work changed after this worker was created. Review the current Telos brief and recover its assignment before starting. Saved chats, messages and work are retained.',
  tool_validation_failed:
    'Mitzo could not validate the current tool operation. Saved work is preserved; inspect conversation recovery before continuing.',
  login_verification_unavailable:
    'ChatGPT login verification is temporarily unavailable. Try again when verification is available. Your draft, saved messages and workspace are retained.',
  login_refresh_invalid:
    'The changed ChatGPT login could not be verified for this chat’s selected account. Review sign-in before continuing. Saved work and messages are retained.',
  login_refresh_reauthorization:
    'This chat’s saved ChatGPT login predates token-refresh continuity. It needs an explicit account reauthorization before continuing. Saved work and queued messages are retained.',
  auth_expired:
    'Your Mitzo sign-in expired. Sign in again, then review the interrupted turn before continuing. Saved work is preserved.',
  auth_revoked:
    'Your Mitzo sign-in was revoked or logged out. Sign in again, then review the interrupted turn before continuing. Saved work is preserved.',
  knowledge_unavailable: KNOWLEDGE_RUNTIME_UNAVAILABLE_MESSAGE,
  input_not_dispatched:
    'This message was not sent to the provider because its original runtime could not be prepared. Completed work will not be rerun.',
  repair_refused:
    'This historical repair could not be qualified safely. Original work and queued messages are retained; nothing was dispatched.',
  runtime_unavailable:
    'The execution runtime could not continue. The conversation, workspace and saved messages are retained.',
  recovery_unavailable:
    'Recovery could not verify the saved session. Your work and queued messages are preserved. Use this reference to inspect the failed recovery step before retrying.',
  recovery_history_unavailable:
    'Recovery could not read the original provider history. Reconnect the selected account and runtime, then retry. Saved work will not be replayed.',
  recovery_history_limit:
    'The interrupted turn exceeds the recovery inspection limit. Its history needs a bounded recovery review before queued messages can continue. Saved work is preserved.',
  recovery_effects_unverified:
    'Recovery found tool or child-agent effects it could not verify. Inspect their original outcomes before continuing. Saved work and queued messages are preserved.',
  native_policy_changed:
    'Native execution policy changed. Mitzo stopped this turn before granting further access. Review saved work and continue with the current policy; earlier actions will not be replayed automatically.',
  workspace_branch_changed:
    'This checkout is no longer on its assigned task branch. Saved commits and files are preserved. Restore the assigned branch while retaining the saved work, then review the interrupted turn before continuing.',
  callbacks_pending:
    'The provider finished, but an original tool callback has not settled. Saved messages remain queued. Completed work will not be rerun.',
  callbacks_failed:
    'An original tool callback could not finish safely. Its outcome needs reconciliation before saved messages can continue. Completed work will not be rerun.',
  turn_completed:
    'This provider turn has already finished. A new tool callback cannot execute on that turn.',
  unsettled_effects:
    'A previous turn has unresolved tool or completion effects. Saved messages remain queued while its original outcome is reconciled. Completed work will not be rerun.',
  provider_active:
    'The previous provider turn is still active. Saved messages remain queued until its exact outcome is confirmed.',
  provider_identity:
    'The provider outcome does not match the retained command and turn. The original work and saved messages are retained for inspection.',
} as const;
export type SessionRuntimeFailureCode = keyof typeof SESSION_RUNTIME_MESSAGES;
export const RuntimeFailureSchema = z.strictObject({
  runtimeFailureCode: z.enum(
    Object.keys(SESSION_RUNTIME_MESSAGES) as [
      SessionRuntimeFailureCode,
      ...SessionRuntimeFailureCode[],
    ],
  ),
  diagnosticId: z.uuid(),
});
export type RuntimeFailure = z.infer<typeof RuntimeFailureSchema>;
export function runtimeFailureMessage(failure: RuntimeFailure): string {
  return `${SESSION_RUNTIME_MESSAGES[failure.runtimeFailureCode]} Reference: ${failure.diagnosticId}`;
}
