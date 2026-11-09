import { createHash } from 'node:crypto';
import type { AccountBinding } from '@mitzo/protocol';
import type {
  CodexConversationStore,
  CodexNativeTurnTarget,
  CommandTransportDiagnostic,
} from './codex-conversation-store.js';
import type { HostCodexCustody } from './host-codex-custody.js';
import { codexStoredAccountKey } from './codex-stored-account.js';
import { historicalFailureEvidenceHash } from './historical-task-failure-evidence.js';
export type RetainedNativeEffectEvidence = {
  target: CodexNativeTurnTarget;
  execution: NonNullable<ReturnType<CodexConversationStore['readNativeExecution']>>;
  custody: HostCodexCustody;
  diagnostic: CommandTransportDiagnostic | undefined;
  callId: string;
  requestHash: string;
  effectOutcome: string | null;
  contentItems: string | null;
};
export type RetainedHostResultObserver = (
  call: Readonly<{ toolName: string; arguments: Record<string, unknown> }>,
  result: Readonly<{ content: string; isError: boolean }>,
  evidence: () => RetainedNativeEffectEvidence,
) => boolean;
/** Shared exact historical identity; none of these descriptive fields alone
 * grants settlement. Only a reviewed full-payload digest can qualify an incident. */
export function retainedNativeEffectEvidence(
  sessionId: string,
  binding: AccountBinding,
  original: RetainedNativeEffectEvidence,
  toolName: string,
  result: { content: string; isError: boolean },
  sources: Record<string, string>,
) {
  const { custody, diagnostic, execution, target } = original;
  if (!diagnostic) throw Error('Original diagnostic unavailable');
  return {
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
    reviewedSourceHashesDigest: historicalFailureEvidenceHash(sources),
    nativeCall: {
      callId: original.callId,
      toolName,
      requestHash: original.requestHash,
      resultContentSha256: createHash('sha256').update(result.content).digest('hex'),
      resultIsError: result.isError,
      resultEffectOutcome: original.effectOutcome,
      resultContentItems: original.contentItems,
      terminalStatus: 'failed',
      terminalSuccess: false,
    },
    originalCustodyIdentity: {
      version: custody.version,
      authSessionId: custody.authSessionId,
      bootstrapId: custody.bootstrapId,
      agentProfileSha256: custody.agentProfileSha256,
      ...(custody.agentContextSha256 ? { agentContextSha256: custody.agentContextSha256 } : {}),
    },
  };
}
