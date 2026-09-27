import type { LiveCapabilityConversationBinding } from './capability-conversation-binding.js';
import { createHash } from 'node:crypto';
import {
  artifactDriverConfigForLease,
  SYMPOSIUM_ARTIFACT_TARGET,
  type ArtifactLease,
  type ArtifactLeaseHost,
} from './symposium-artifact-lease.js';
import { canonicalReviewJson } from './symposium-review-records.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import {
  createGithubPublishPrExecutor,
  type GithubHostPublisher,
} from './connections/capabilities/github-publish-pr.js';
import { type OpenShellControlRunner } from './connections/capabilities/github-publish-pr-transport.js';
import type {
  CapabilityExecutionContext,
  CapabilityConnection,
} from './connections/capabilities/types.js';
import { OpenShellSymposiumGitInspection } from './symposium-review-git-inspection.js';
import type { CapabilityOperationStore } from './connections/capabilities/operation-store.js';
import {
  canonicalJson,
  validateCapabilityInput,
} from './connections/capabilities/input-validation.js';
import { connectionTemplateRegistry } from './connections/registry.js';

/** Versioned digest of Git's committed regular-file manifest, not a worktree checksum.
 * Git object IDs bind blob contents; this digest also binds paths and executable modes.
 * Symlinks, gitlinks, malformed/unbounded trees are deliberately unsupported. */
export function committedTreeDigest(tree: string): string {
  if (
    (tree !== '' && !tree.endsWith('\0')) ||
    Buffer.byteLength(tree) > 1024 * 1024 ||
    tree.includes('\ufffd')
  )
    throw new Error('Unsupported committed tree');
  const seen = new Set<string>();
  const entries = (tree === '' ? [] : tree.slice(0, -1).split('\0'))
    .map((line) => {
      const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(line);
      if (!match) throw new Error('Unsupported committed tree entry');
      const [, mode, oid, path] = match;
      if (
        seen.has(path) ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git') ||
        [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error('Unsupported committed tree path');
      seen.add(path);
      return { mode, oid, path };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return createHash('sha256')
    .update('mitzo-committed-tree-v1\0')
    .update(canonicalReviewJson(entries))
    .digest('hex');
}

type ReviewRecord = NonNullable<ReturnType<SymposiumReviewStore['getReviewRecord']>>;
type Builder = ReviewRecord['snapshot']['workflow']['implementer'];
export interface ReviewPublicationBinding {
  /** Snapshot from current admitted seat lifecycle, never request data. */
  builder: Builder;
  membershipGeneration: number;
  sandboxName: string;
  lease: ArtifactLease;
  operation: CapabilityExecutionContext['operation'];
  publicConfig: Readonly<Record<string, string | readonly string[]>>;
}
export interface ReviewPublicationAttachment extends LiveCapabilityConversationBinding {
  sessionId: string;
  seatId: string;
  membershipGeneration: number;
}
export interface ReviewPublicationDependencies {
  store: SymposiumReviewStore;
  operations: Pick<CapabilityOperationStore, 'get' | 'getGrant'>;
  leaseHost: ArtifactLeaseHost;
  control: OpenShellControlRunner;
  workspaceId: string;
  publisher: Pick<GithubHostPublisher, 'policy' | 'findOpen'>;
  getConnection(
    id: string,
  ): (CapabilityConnection & { gatewayProviderId: string | null }) | undefined;
  /** Current seat-scoped lifecycle attachment; never reconstructed from durable operation metadata. */
  getLiveAttachment(
    context: ReviewContext,
    seatId: string,
    membershipGeneration: number,
  ): ReviewPublicationAttachment | null;
  /** Must resolve only currently admitted builder seats and a real durable capability operation. */
  resolveBinding(context: ReviewContext, record: ReviewRecord): ReviewPublicationBinding | null;
}

/** Shared pre/post-approval validation; caller selects the exact durable operation phase. */
export async function prepareSymposiumReviewPublication(
  deps: ReviewPublicationDependencies,
  context: ReviewContext,
  recordId: string,
  input: Readonly<Record<string, string | boolean>>,
  signal: AbortSignal,
  phase: 'pending_approval' | 'verification_pending' = 'pending_approval',
) {
  const record = deps.store.getReviewRecord(context.owner, context.sessionId, recordId);
  if (!record) throw new Error('Review record not found');
  const binding = deps.resolveBinding(context, record);
  if (!binding) throw new Error('Publication builder binding unavailable');
  const fingerprint = canonicalReviewJson(binding);
  let attachmentFingerprint: string | undefined;
  const check = async () => {
    signal.throwIfAborted();
    const current = deps.resolveBinding(context, record);
    if (!current || canonicalReviewJson(current) !== fingerprint)
      throw new Error('Publication builder binding changed');
    const { operation, lease } = current;
    const durable = deps.operations.get(operation.id);
    const connection = deps.getConnection(operation.connectionId);
    const grant = deps.operations.getGrant(
      operation.connectionId,
      operation.connectionRevision,
      'github.publish-pr',
      1,
    );
    const workflow = deps.store.get(record.snapshot.workflowId);
    if (
      !workflow ||
      workflow.status !== 'verified' ||
      workflow.decisionCode ||
      workflow.artifactRevision !== record.snapshot.artifactRevision ||
      workflow.artifactHash !== record.snapshot.artifactHash ||
      deps.store.history(workflow.workflowId).at(-1)?.sequence !== record.snapshot.historySequence
    )
      throw new Error('Review record is no longer current');
    if (
      canonicalReviewJson(current.builder) !==
        canonicalReviewJson(record.snapshot.workflow.implementer) ||
      !Number.isSafeInteger(current.membershipGeneration) ||
      current.membershipGeneration < 1 ||
      lease.request.sessionId !== context.sessionId ||
      lease.request.seatId !== current.builder.seatId ||
      lease.request.workspaceId !== deps.workspaceId ||
      lease.request.access !== 'writer'
    )
      throw new Error('Publication seat or lease mismatch');
    if (
      !durable ||
      canonicalReviewJson(durable) !== canonicalReviewJson(operation) ||
      operation.status !== phase ||
      operation.capabilityId !== 'github.publish-pr' ||
      operation.capabilityVersion !== 1 ||
      operation.conversationId !== context.sessionId ||
      operation.accountId !== current.builder.accountId ||
      !connection ||
      connection.status !== 'active' ||
      connection.templateId !== 'github-readonly' ||
      connection.templateVersion !== 1 ||
      connection.revision !== operation.connectionRevision ||
      !connection.desiredAccountIds.includes(operation.accountId) ||
      !grant ||
      grant.id !== operation.grantId ||
      grant.status !== 'active' ||
      !grant.accountIds.includes(operation.accountId)
    )
      throw new Error('Publication capability binding unavailable');
    const attachment = deps.getLiveAttachment(
      context,
      current.builder.seatId,
      current.membershipGeneration,
    );
    if (
      !attachment ||
      attachment.sessionId !== context.sessionId ||
      attachment.seatId !== current.builder.seatId ||
      attachment.membershipGeneration !== current.membershipGeneration ||
      attachment.accountId !== operation.accountId ||
      attachment.connectionId !== operation.connectionId ||
      attachment.connectionRevision !== operation.connectionRevision ||
      !attachment.gatewayProviderId ||
      attachment.gatewayProviderId !== connection.gatewayProviderId ||
      attachment.sandboxName !== current.sandboxName ||
      attachment.workspace !== SYMPOSIUM_ARTIFACT_TARGET
    )
      throw new Error('Publication live attachment unavailable');
    const attached = canonicalReviewJson(attachment);
    if (attachmentFingerprint && attachmentFingerprint !== attached)
      throw new Error('Publication live attachment changed');
    attachmentFingerprint = attached;
    await artifactDriverConfigForLease(deps.leaseHost, lease);
  };
  await check();
  const template = connectionTemplateRegistry.getCapabilityTemplate('github.publish-pr', 1)!;
  const validated = validateCapabilityInput(template.inputSchema, input);
  if (
    createHash('sha256').update(canonicalJson(validated)).digest('hex') !==
    binding.operation.inputHash
  )
    throw new Error('Publication input changed');
  // The record reference is mandatory public metadata; never append arbitrary history.
  const reference = `Review record: ${record.recordId}\nSHA256: ${record.contentHash}`;
  if (typeof validated.body !== 'string' || !validated.body.endsWith(reference))
    throw new Error('PR body must include the exact review record reference');
  const transport = new OpenShellSymposiumGitInspection(deps.control, deps.workspaceId);
  let inspectedSnapshot: string | undefined;
  const inspect = async (request: Parameters<OpenShellSymposiumGitInspection['inspect']>[0]) => {
    await check();
    const before = await transport.inspect(request);
    const tree = await transport.committedTree({ ...request, sourceOid: before.sourceOid });
    if (
      before.sourceOid !== record.snapshot.artifactRevision ||
      committedTreeDigest(tree) !== record.snapshot.artifactHash
    )
      throw new Error('Reviewed artifact does not match committed Git tree');
    const after = await transport.inspect(request);
    if (canonicalReviewJson(before) !== canonicalReviewJson(after))
      throw new Error('Git state changed during publication inspection');
    const snapshot = canonicalReviewJson(after);
    if (inspectedSnapshot && inspectedSnapshot !== snapshot)
      throw new Error('Git state changed after publication preflight');
    inspectedSnapshot = snapshot;
    await check();
    return after;
  };
  const bindingFingerprint = createHash('sha256')
    .update(
      canonicalReviewJson({
        builder: binding.builder,
        membershipGeneration: binding.membershipGeneration,
        sandboxName: binding.sandboxName,
        lease: binding.lease,
        publicConfig: binding.publicConfig,
        attachment: attachmentFingerprint,
        operationId: binding.operation.id,
        inputHash: binding.operation.inputHash,
        grantId: binding.operation.grantId,
        connectionId: binding.operation.connectionId,
        connectionRevision: binding.operation.connectionRevision,
      }),
    )
    .digest('hex');
  return { record, binding, validated, check, inspect, bindingFingerprint };
}

/** Read-only concrete preflight adapter. It cannot dispatch, approve or publish.
 * A future service integration must repeat these checks after forced approval and
 * bind the durable operation to the record. A preview is never that authorization. */
export function createSymposiumReviewPublicationPreflight(deps: ReviewPublicationDependencies) {
  return {
    async inspect(
      context: ReviewContext,
      recordId: string,
      input: Readonly<Record<string, string | boolean>>,
      signal: AbortSignal,
    ) {
      const { record, binding, validated, inspect } =
        await prepareSymposiumReviewPublication(deps, context, recordId, input, signal);
      const forbidden = async (): Promise<never> => {
        throw new Error('Publication mutation is unavailable');
      };
      const executor = createGithubPublishPrExecutor({
        sandbox: { inspect, exportBundle: forbidden },
        host: {
          policy: (request) => deps.publisher.policy(request),
          findOpen: (request) => deps.publisher.findOpen(request),
          reconstruct: forbidden,
          push: forbidden,
          create: forbidden,
          update: forbidden,
          read: forbidden,
          readBranch: forbidden,
          cleanup: forbidden,
        },
        resolveConversation: () => ({
          workspace: SYMPOSIUM_ARTIFACT_TARGET,
          sandboxName: binding.sandboxName,
        }),
        resolvePublicConfig: () => binding.publicConfig,
      });
      const preflight = await executor.preflight!({
        operation: binding.operation,
        input: validated,
        signal,
      });
      const { approvalInput, approvalHash } = binding.operation;
      if (approvalInput != null || approvalHash != null) {
        const encoded = canonicalJson(preflight.approvalInput);
        if (
          approvalInput == null ||
          approvalHash == null ||
          canonicalJson(approvalInput) !== encoded ||
          createHash('sha256').update(encoded).digest('hex') !== approvalHash
        )
          throw new Error('Publication pending approval changed');
      }
      // Remote policy/PR reads may yield; repeat local artifact and authority checks afterward.
      await inspect({
        sandboxName: binding.sandboxName,
        repositoryPath: String(validated.repositoryPath),
        baseBranch: String(validated.baseBranch),
        signal,
      });
      return {
        kind: 'preview_only' as const,
        recordId: record.recordId,
        recordHash: record.contentHash,
        approvalInput: preflight.approvalInput,
        publication: 'not_created' as const,
      };
    },
  };
}
