import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { taskExecutionFingerprint } from './task-execution-store.js';
import { resolve } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import type {
  CodexConversationStore,
  CodexNativeTurnTarget,
  CommandTransportDiagnostic,
} from './codex-conversation-store.js';
import type { HostCodexCustody } from './host-codex-custody.js';
import { codexStoredAccountKey } from './codex-stored-account.js';
import { taskExecutionSchema } from './task-execution-definitions.js';
import { getTaskExecutionStore } from './task-execution-runtime.js';
import {
  historicalFailureEvidenceHash,
  qualifiesReviewedHistoricalTaskFailure,
} from './historical-task-failure-evidence.js';
import { reviewedHistoricalTaskSources } from './historical-task-failure-manifest.js';
type HistoricalTaskContext = {
  target: CodexNativeTurnTarget;
  execution: NonNullable<ReturnType<CodexConversationStore['readNativeExecution']>>;
  custody: HostCodexCustody;
  diagnostic: CommandTransportDiagnostic | undefined;
  callId: string;
  requestHash: string;
  effectOutcome: string | null;
  contentItems: string | null;
};
const textHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Called at the recovery mutation boundary, after matching the native tool's
 * request hash. Never invokes begin/finish, dispatches, or changes either receipt. */
export function hasRetainedTaskExecutionResult(
  sessionId: string,
  binding: AccountBinding,
  originalCwd: string,
  arguments_: Record<string, unknown>,
  result: { content: string; isError: boolean },
  observeHistorical?: () => HistoricalTaskContext,
): boolean {
  try {
    const input = taskExecutionSchema.parse(arguments_);
    if (!['run', 'commit'].includes(input.operation) || !input.grantId || !input.requestId)
      return false;
    const tool = input.operation === 'run' ? 'Bash' : 'GitCommit';
    const exact =
      input.operation === 'run'
        ? { command: input.command }
        : { files: input.files, message: input.message };
    if (input.operation === 'run' ? !input.command : !input.files || !input.message) return false;
    // A historical symlink is never resolved against today's filesystem. The
    // original canonical cwd must match its executor's exact operation fingerprint.
    const cwd = input.cwd ? resolve(originalCwd, input.cwd) : originalCwd;
    const fingerprint = taskExecutionFingerprint(tool, exact, cwd, input.timeoutMs);
    const observed = getTaskExecutionStore().observeRunForRecovery({
      grantId: input.grantId,
      sessionId,
      requestId: input.requestId,
      fingerprint,
      cwd,
      binding,
    });
    if (!observed) return false;
    if (observed.result !== null) return isDeepStrictEqual(observed.result, result);
    const historical = observeHistorical?.();
    if (!historical?.diagnostic || !result.isError) return false;
    const { revokedAt, ...grantIdentity } = observed.grant;
    void revokedAt; // Historical observation cannot renew or revive this consent.
    const { custody, diagnostic, execution, target } = historical;
    return qualifiesReviewedHistoricalTaskFailure({
      version: 'mitzo-historical-task-failure-v1',
      kind:
        input.operation === 'run'
          ? 'foreground_invocation_terminated'
          : 'refused_before_commit_publication',
      conversationId: sessionId,
      accountKey: codexStoredAccountKey(binding),
      nativeTarget: target,
      acceptedExecutionHash: historicalFailureEvidenceHash(execution),
      originalWorkspaceDigest: diagnostic.workspaceDigest,
      originalPolicyRevision: execution.policy.policyRevision,
      originalRuntimeBindingRevision: diagnostic.runtimeBindingRevision,
      originalNativeArtifactSha256: diagnostic.nativeArtifactSha256,
      originalNativeVersion: diagnostic.nativeVersion,
      originalReleaseRevision: diagnostic.releaseRevision,
      reviewedSourceHashesDigest: historicalFailureEvidenceHash(reviewedHistoricalTaskSources),
      nativeCall: {
        callId: historical.callId,
        toolName: 'TaskExecution',
        requestHash: historical.requestHash,
        resultContentSha256: textHash(result.content),
        resultIsError: result.isError,
        resultEffectOutcome: historical.effectOutcome,
        resultContentItems: historical.contentItems,
        terminalStatus: 'failed',
        terminalSuccess: false,
      },
      taskRun: {
        grantId: input.grantId,
        grantIdentityHash: historicalFailureEvidenceHash(grantIdentity),
        memberIdentityHash: historicalFailureEvidenceHash(observed.member),
        sessionId,
        requestId: input.requestId,
        operation: input.operation,
        cwd,
        fingerprint,
        result: null,
      },
      originalCustodyIdentity: {
        version: custody.version,
        authSessionId: custody.authSessionId,
        bootstrapId: custody.bootstrapId,
        agentProfileSha256: custody.agentProfileSha256,
        ...(custody.agentContextSha256 ? { agentContextSha256: custody.agentContextSha256 } : {}),
      },
    });
  } catch {
    return false;
  }
}
