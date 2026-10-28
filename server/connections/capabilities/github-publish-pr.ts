import { isGitBranchName } from '../../git-branch.js';
import { Buffer } from 'node:buffer';
import { posix as path } from 'node:path';
import type { JsonValue } from '../types.js';
import type {
  CapabilityExecutionContext,
  CapabilityExecutor,
  CapabilityOperation,
} from './types.js';
import { CapabilityRecoveryPendingError } from './types.js';
import { canonicalJson } from './input-validation.js';
import { capabilityApprovalPayload } from './approval.js';
import {
  GithubPublicationReviewError,
  markGithubPublicationNotDispatched,
} from '../../github-publication-review-failure.js';

/** A deliberately small binary budget. The sandbox must not become a data exfiltration channel. */
export const GITHUB_PUBLISH_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const GITHUB_PUBLISH_MAX_CHANGED_FILES = 500;
/** The complete list is shown in the shared approval card; oversized scope is rejected. */
export const GITHUB_PUBLISH_MAX_APPROVAL_CHANGED_FILES = 64;
export const GITHUB_PUBLISH_MAX_APPROVAL_PATH_CHARS = 120;

export interface GithubPublishConversation {
  /** Trusted OpenShell workdir, supplied by lifecycle state rather than tool input. */
  workspace: string;
  sandboxName: string;
}

export interface GithubSandboxInspection {
  seededPublication?: {
    originalSourceOid: string;
    seedTreeOid: string;
    projectedBaseOid: string;
    patchSha256: string;
    seedSourceIdentity: string;
    originalCommitCount: string;
    originalSourceBranch: string;
  };
  canonicalRepositoryPath: string;
  /** Empty means clean. This is deliberately not a user-provided porcelain string. */
  status: string;
  sourceBranch: string | null;
  sourceOid: string;
  defaultBranch: string;
  /** The exact origin URL observed by Git, not an arbitrary configured URL. */
  originUrl: string;
  commitsAhead: number;
  changedFiles: readonly string[];
  /** A controller-supplied protected-branch decision, evaluated before export/network. */
  sourceBranchProtected: boolean;
  /** Control transport proved every component beneath the trusted workspace is non-symlink. */
  symlinkFree: boolean;
}

/**
 * The only sandbox authority this executor needs. Implementations use the
 * OpenShell control plane; they never receive a GitHub write credential.
 */
export interface GithubSandboxTransport {
  inspect(input: {
    sandboxName: string;
    repositoryPath: string;
    baseBranch: string;
    signal: AbortSignal;
  }): Promise<GithubSandboxInspection>;
  exportBundle(input: {
    sandboxName: string;
    repositoryPath: string;
    sourceBranch: string;
    sourceOid: string;
    baseBranch: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<Buffer>;
}

export interface GithubPullRequest {
  repository: string;
  sourceBranch: string;
  baseBranch: string;
  url: string;
  id: string;
  title: string;
  body: string;
  draft: boolean;
  /** Omitted by older test doubles; production transport always supplies it. */
  state?: 'open' | 'closed';
  merged?: boolean;
}

/**
 * Host-only publisher. Its implementation owns controller credentials and is
 * forbidden from placing them in an argument, result, error, or sandbox call.
 */
export interface GithubHostPublisher {
  policy(input: {
    repository: string;
    sourceBranch: string;
    signal: AbortSignal;
  }): Promise<{ defaultBranch: string; sourceBranchProtected: boolean }>;
  reconstruct(input: {
    repository: string;
    sourceBranch: string;
    sourceOid: string;
    baseBranch: string;
    bundle: Buffer;
    operationId: string;
    signal: AbortSignal;
    assertRuntimeCurrent?: () => Promise<void>;
  }): Promise<{ directory: string; cleanupDirectory?: string }>;
  push(input: {
    directory: string;
    sourceBranch: string;
    operationId: string;
    signal: AbortSignal;
    assertRuntimeCurrent?: () => Promise<void>;
  }): Promise<void>;
  findOpen(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    operationId: string;
    signal: AbortSignal;
    assertRuntimeCurrent?: () => Promise<void>;
  }): Promise<GithubPullRequest | null>;
  create(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
    operationId: string;
    signal: AbortSignal;
    assertRuntimeCurrent?: () => Promise<void>;
  }): Promise<GithubPullRequest>;
  update(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    pullRequest: GithubPullRequest;
    title: string;
    body: string;
    draft: boolean;
    operationId: string;
    signal: AbortSignal;
    assertRuntimeCurrent?: () => Promise<void>;
  }): Promise<GithubPullRequest>;
  read(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    externalResultId?: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<GithubPullRequest | null>;
  readBranch(input: {
    repository: string;
    sourceBranch: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<string | null>;
  cleanup(directory: string): Promise<void>;
}

export interface GithubPublishPrDependencies {
  sandbox: GithubSandboxTransport;
  host: GithubHostPublisher;
  resolveConversation(operation: CapabilityOperation): GithubPublishConversation | undefined;
  /** Public config from the authoritative current connection record. */
  resolvePublicConfig(
    operation: CapabilityOperation,
  ): Readonly<Record<string, string | readonly string[]>> | undefined;
  reviewCommittedChange?: GithubPublicationReview;
}

/** Host-only frozen publication evidence. The directory is never model context
 * or tool authority: the reviewer extracts bounded Git object text itself. */
export interface GithubPublicationReviewInput {
  operation: CapabilityOperation;
  repository: string;
  sourceBranch: string;
  sourceOid: string;
  baseBranch: string;
  bundle: Buffer;
  directory: string;
  signal: AbortSignal;
  assertRuntimeCurrent?: () => Promise<void>;
}
export interface GithubPublicationReviewReceipt {
  receiptId: string;
  evidenceSha256: string;
  summary: string;
  reports?: readonly GithubPublicationReviewReport[];
  /** Revalidate original authority and exact semantic Git evidence against the
   * fresh host reconstruction. This closure is never accepted from tool JSON. */
  assertCurrent(input: GithubPublicationReviewInput): Promise<void>;
}
export interface GithubPublicationReviewReport {
  reportId: string;
  scope: string;
  accountId: string;
  model: string;
  reasoningEffort: string | null;
  evidenceSha256: string;
  verdict: 'approve';
  findings: readonly { severity: 'blocking' | 'non_blocking'; path: string; summary: string }[];
  coverage: {
    changedPaths: readonly string[];
    changedPathCount: number;
    fullContextPaths: readonly string[];
    fullContextPathCount: number;
    contextReads: readonly {
      path: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      remainingBefore: number;
      remainingAfter: number;
      complete: boolean;
    }[];
    contextReadCount: number;
    searches: readonly { query: string; pathPrefix?: string; matchedPathCount: number }[];
    searchCount: number;
    rounds: number;
    checksRun: false;
    unresolvedNeeds: readonly string[];
    summary?: string;
  };
}
export type GithubPublicationReview = (
  input: GithubPublicationReviewInput,
) => Promise<GithubPublicationReviewReceipt>;

type Input = Readonly<{
  connectionId: string;
  repositoryPath: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
}>;

const repository =
  /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

function reject(message: string): never {
  throw new Error(message);
}
const validBranch = isGitBranchName;
function inputOf(value: Readonly<Record<string, string | boolean>>): Input {
  const fields = ['connectionId', 'repositoryPath', 'baseBranch', 'title', 'body'] as const;
  if (fields.some((field) => typeof value[field] !== 'string') || typeof value.draft !== 'boolean')
    return reject('Invalid GitHub publish input');
  return value as Input;
}
/** POSIX paths are sandbox paths. Reject lexical ambiguity before control-plane execution. */
export function canonicalRepositoryPath(workspace: string, submitted: string): string {
  if (
    !workspace.startsWith('/') ||
    !submitted.startsWith('/') ||
    submitted.includes('\\') ||
    submitted.includes('\0') ||
    submitted.length > 256
  )
    return reject('Repository path is invalid');
  const root = path.resolve(workspace);
  const resolved = path.resolve(submitted);
  if (resolved !== root && !resolved.startsWith(root + '/'))
    return reject('Repository path escapes workspace');
  // A noncanonical spelling would make a later symlink/repository check harder
  // to reason about. Require the model to use the exact workspace path.
  if (submitted !== resolved) return reject('Repository path is ambiguous');
  return resolved;
}
export function githubRepositoryFromOrigin(origin: string): string {
  const ssh = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(origin);
  const https = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(
    origin,
  );
  const matched = ssh ?? https;
  if (!matched) return reject('Repository origin is not GitHub');
  const value = `${matched[1]!.toLowerCase()}/${matched[2]!.toLowerCase()}`;
  if (!repository.test(value)) return reject('Repository origin is invalid');
  return value;
}
function allowlist(config: Readonly<Record<string, string | readonly string[]>>, name: string) {
  const value = config[name];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string'))
    return reject(`GitHub connection ${name} is invalid`);
  return new Set(value);
}
function assertPullRequest(
  value: GithubPullRequest,
  expected: { repository: string; sourceBranch: string; baseBranch: string },
) {
  let url: URL | undefined;
  try {
    url = new URL(value.url);
  } catch {
    /* rejected below */
  }
  if (
    !value ||
    value.repository.toLowerCase() !== expected.repository.toLowerCase() ||
    value.sourceBranch !== expected.sourceBranch ||
    value.baseBranch !== expected.baseBranch ||
    typeof value.id !== 'string' ||
    !url ||
    url.protocol !== 'https:' ||
    url.port !== '' ||
    !!url.username ||
    !!url.password ||
    !!url.search ||
    !!url.hash ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.pathname.toLowerCase() !== `/${expected.repository}/pull/${value.id}`.toLowerCase()
  )
    return reject('GitHub pull request result is invalid');
  return value;
}
function output(
  pr: GithubPullRequest,
  inspection: GithubSandboxInspection,
  created: boolean,
): JsonValue {
  return {
    repository: pr.repository,
    sourceBranch: pr.sourceBranch,
    sourceOid: inspection.sourceOid,
    baseBranch: pr.baseBranch,
    pullRequestUrl: pr.url,
    pullRequestId: pr.id,
    created,
    ...(pr.state
      ? {
          pullRequestState: pr.state,
          draft: pr.draft,
          merged: pr.merged ?? false,
          observedAt: Date.now(),
        }
      : {}),
    commitsAhead: inspection.commitsAhead,
    ...(inspection.seededPublication ?? {}),
    changedFiles: inspection.changedFiles.slice(0, GITHUB_PUBLISH_MAX_CHANGED_FILES),
  };
}
function assertRequestedMetadata(pr: GithubPullRequest, input: Input) {
  if (pr.title !== input.title || pr.body !== input.body || pr.draft !== input.draft)
    reject('GitHub pull request verification failed');
}
function samePullRequestUrl(left: string, right: string) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      a.protocol === 'https:' &&
      b.protocol === 'https:' &&
      a.port === '' &&
      b.port === '' &&
      !a.username &&
      !a.password &&
      !b.username &&
      !b.password &&
      !a.search &&
      !b.search &&
      !a.hash &&
      !b.hash &&
      a.hostname.toLowerCase() === 'github.com' &&
      b.hostname.toLowerCase() === 'github.com' &&
      a.pathname.toLowerCase() === b.pathname.toLowerCase()
    );
  } catch {
    return false;
  }
}
/**
 * Reviewed executor factory. All mutation dependencies are injected, which
 * keeps the security boundary testable and avoids a credential-bearing module
 * singleton.
 */
export function createGithubPublishPrExecutor(
  deps: GithubPublishPrDependencies,
): CapabilityExecutor {
  return createGithubArtifactPublishPrExecutor({
    host: deps.host,
    resolvePublicConfig: deps.resolvePublicConfig,
    reviewCommittedChange: deps.reviewCommittedChange,
    resolveWorkspace: (operation) => deps.resolveConversation(operation)?.workspace,
    inspect: (input) => {
      const conversation = deps.resolveConversation(input.operation);
      if (!conversation) return Promise.reject(new Error('Live GitHub attachment unavailable'));
      return deps.sandbox.inspect({ ...input, sandboxName: conversation.sandboxName });
    },
    exportBundle: (input) => {
      const conversation = deps.resolveConversation(input.operation);
      if (!conversation) return Promise.reject(new Error('Live GitHub attachment unavailable'));
      return deps.sandbox.exportBundle({ ...input, sandboxName: conversation.sandboxName });
    },
  });
}

/** Host-owned source contract shared by live sandboxes and physically sealed artifacts.
 * A sealed source supplies its own exact seal-bound transport, never a fake sandbox. */
export interface GithubArtifactPublishDependencies {
  host: GithubHostPublisher;
  resolvePublicConfig: GithubPublishPrDependencies['resolvePublicConfig'];
  /** Ordinary publication supplies its independent host reviewer. Existing
   * sealed Symposium publication retains its separately owned review fence. */
  reviewCommittedChange?: GithubPublicationReview;
  resolveWorkspace(operation: CapabilityOperation): string | undefined;
  inspect(
    input: Omit<Parameters<GithubSandboxTransport['inspect']>[0], 'sandboxName'> & {
      operation: CapabilityOperation;
    },
  ): Promise<GithubSandboxInspection>;
  exportBundle(
    input: Omit<Parameters<GithubSandboxTransport['exportBundle']>[0], 'sandboxName'> & {
      operation: CapabilityOperation;
    },
  ): Promise<Buffer>;
}
export function createGithubArtifactPublishPrExecutor(
  deps: GithubArtifactPublishDependencies,
): CapabilityExecutor {
  // Durable approval projections describe review, but cannot recreate its
  // private authority. A restarted owner must review again on a new operation;
  // uncertain writes continue through the existing read-only recovery path.
  const reviews = new Map<
    string,
    { binding: string; receipt: GithubPublicationReviewReceipt; expiresAt: number }
  >();
  const reviewBinding = (
    context: CapabilityExecutionContext,
    state: Awaited<ReturnType<typeof inspect>>,
  ) =>
    canonicalJson({
      operationId: context.operation.id,
      conversationId: context.operation.conversationId,
      accountId: context.operation.accountId,
      connectionId: context.operation.connectionId,
      connectionRevision: context.operation.connectionRevision,
      input: state.input,
      repository: state.repository,
      sourceBranch: state.inspection.sourceBranch,
      sourceOid: state.inspection.sourceOid,
    });
  const reviewProjection = (
    receipt: GithubPublicationReviewReceipt | undefined,
  ): Readonly<Record<string, string>> =>
    receipt
      ? {
          reviewReceiptId: receipt.receiptId,
          reviewEvidenceSha256: receipt.evidenceSha256,
          reviewSummary: receipt.summary,
        }
      : {};
  const exportedBundle = async (
    context: CapabilityExecutionContext,
    state: Awaited<ReturnType<typeof inspect>>,
  ) => {
    const bundle = await deps.exportBundle({
      operation: context.operation,
      repositoryPath: state.repositoryPath,
      sourceBranch: state.inspection.sourceBranch!,
      sourceOid: state.inspection.sourceOid,
      baseBranch: state.input.baseBranch,
      maxBytes: GITHUB_PUBLISH_MAX_BUNDLE_BYTES,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (
      !Buffer.isBuffer(bundle) ||
      !bundle.length ||
      bundle.length > GITHUB_PUBLISH_MAX_BUNDLE_BYTES
    )
      reject('Committed change export exceeds the safety limit');
    return bundle;
  };
  const reviewInput = (
    context: CapabilityExecutionContext,
    state: Awaited<ReturnType<typeof inspect>>,
    bundle: Buffer,
    directory: string,
  ): GithubPublicationReviewInput => ({
    operation: structuredClone(context.operation),
    repository: state.repository,
    sourceBranch: state.inspection.sourceBranch!,
    sourceOid: state.inspection.sourceOid,
    baseBranch: state.input.baseBranch,
    bundle: Buffer.from(bundle),
    directory,
    signal: context.signal,
    ...(context.assertRuntimeCurrent ? { assertRuntimeCurrent: context.assertRuntimeCurrent } : {}),
  });
  const inspect = async (context: CapabilityExecutionContext) => {
    const input = inputOf(context.input);
    if (input.connectionId !== context.operation.connectionId) reject('GitHub connection changed');
    if (!validBranch(input.baseBranch)) reject('Base branch is invalid');
    const workspace = deps.resolveWorkspace(context.operation);
    const config = deps.resolvePublicConfig(context.operation);
    if (!workspace || !config) reject('GitHub publish access is unavailable');
    const repositoryPath = canonicalRepositoryPath(workspace, input.repositoryPath);
    const inspection = await deps.inspect({
      operation: context.operation,
      repositoryPath,
      baseBranch: input.baseBranch,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (inspection.canonicalRepositoryPath !== repositoryPath || !inspection.symlinkFree)
      reject('Repository path is ambiguous');
    if (inspection.status !== '') reject('Repository working tree is dirty');
    if (!inspection.sourceBranch || !validBranch(inspection.sourceBranch))
      reject('Repository HEAD is detached');
    if (!Number.isSafeInteger(inspection.commitsAhead) || inspection.commitsAhead < 1)
      reject('Repository has no commits ahead of base');
    if (
      inspection.changedFiles.length > GITHUB_PUBLISH_MAX_APPROVAL_CHANGED_FILES ||
      inspection.changedFiles.some(
        (file) => typeof file !== 'string' || file.length > GITHUB_PUBLISH_MAX_APPROVAL_PATH_CHARS,
      ) ||
      !/^[a-f0-9]{40,64}$/i.test(inspection.sourceOid)
    )
      reject('Changed-file summary is invalid');
    const repo = githubRepositoryFromOrigin(inspection.originUrl);
    if (!allowlist(config, 'allowedRepositories').has(repo)) reject('Repository is not allowed');
    if (!allowlist(config, 'allowedBaseBranches').has(input.baseBranch))
      reject('Base branch is not allowed');
    const policy = await deps.host.policy({
      repository: repo,
      sourceBranch: inspection.sourceBranch,
      signal: context.signal,
    });
    if (
      !validBranch(policy.defaultBranch) ||
      inspection.sourceBranch === policy.defaultBranch ||
      inspection.sourceBranch === input.baseBranch ||
      policy.sourceBranchProtected ||
      inspection.sourceBranchProtected ||
      isProtectedGithubSourceBranch(inspection.sourceBranch)
    )
      reject('Source branch is protected');
    return { input, repositoryPath, inspection, repository: repo };
  };
  const approval = (
    state: Awaited<ReturnType<typeof inspect>>,
    existing: GithubPullRequest | null,
    receipt?: GithubPublicationReviewReceipt,
  ): Readonly<Record<string, string | boolean>> => ({
    ...state.input,
    repository: state.repository,
    sourceBranch: state.inspection.sourceBranch!,
    sourceOid: state.inspection.sourceOid,
    baseBranch: state.input.baseBranch,
    commitCount: String(state.inspection.commitsAhead),
    changedFiles: JSON.stringify(state.inspection.changedFiles),
    existingPullRequest: existing ? 'update' : 'create',
    // The approval binds an update to this repository-local PR identity, not
    // merely to the fact that an open PR happened to exist at preflight.
    existingPullRequestId: existing?.id ?? '',
    existingPullRequestUrl: existing?.url ?? '',
    ...(state.inspection.seededPublication ?? {}),
    ...reviewProjection(receipt),
  });
  const assertApproved = (
    context: CapabilityExecutionContext,
    state: Awaited<ReturnType<typeof inspect>>,
    existing: GithubPullRequest | null,
    receipt?: GithubPublicationReviewReceipt,
  ) => {
    // CapabilityService always supplies this field after durable preflight.
    // Production must never permit a direct executor caller to skip the same
    // reviewed action card. Development-only direct unit fixtures remain
    // useful, while the service contract is enforced in every environment.
    if (
      !context.approvalInput &&
      (deps.reviewCommittedChange || process.env.NODE_ENV === 'production')
    )
      reject('GitHub publish approval is required');
    if (
      context.approvalInput &&
      canonicalJson(context.approvalInput) !== canonicalJson(approval(state, existing, receipt))
    )
      reject('GitHub repository changed after approval');
  };
  return {
    async preflight(context) {
      const state = await inspect(context);
      let receipt: GithubPublicationReviewReceipt | undefined;
      if (deps.reviewCommittedChange) {
        reviews.delete(context.operation.id);
        const bundle = await exportedBundle(context, state);
        let cleanup: string | undefined;
        try {
          const reconstructed = await deps.host.reconstruct({
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            sourceOid: state.inspection.sourceOid,
            baseBranch: state.input.baseBranch,
            bundle,
            operationId: context.operation.id,
            signal: context.signal,
            ...(context.assertRuntimeCurrent
              ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
              : {}),
          });
          cleanup = reconstructed.cleanupDirectory ?? reconstructed.directory;
          if (!reconstructed.directory) reject('Host reconstruction failed');
          const evidence = reviewInput(context, state, bundle, reconstructed.directory);
          receipt = await deps.reviewCommittedChange(evidence);
          if (
            !receipt ||
            typeof receipt.receiptId !== 'string' ||
            !/^[A-Za-z0-9._:-]{1,128}$/.test(receipt.receiptId) ||
            !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256) ||
            typeof receipt.summary !== 'string' ||
            !receipt.summary.trim() ||
            receipt.summary.length > 512 ||
            typeof receipt.assertCurrent !== 'function'
          )
            reject('GitHub independent review receipt is invalid');
          if (
            receipt.reports &&
            (receipt.reports.length !== 2 ||
              Buffer.byteLength(JSON.stringify(receipt.reports), 'utf8') > 20000)
          )
            reject('GitHub independent review reports are invalid');
          receipt = Object.freeze({
            receiptId: receipt.receiptId,
            evidenceSha256: receipt.evidenceSha256,
            summary: receipt.summary,
            ...(receipt.reports ? { reports: structuredClone(receipt.reports) } : {}),
            assertCurrent: receipt.assertCurrent.bind(receipt),
          });
          await receipt.assertCurrent(evidence);
          if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
          context.signal.throwIfAborted();
          // Keep the process-local authority bounded even when action approval
          // is denied or abandoned. Expiration only requires another review.
          for (const [id, entry] of reviews) if (entry.expiresAt <= Date.now()) reviews.delete(id);
          while (reviews.size >= 128) reviews.delete(reviews.keys().next().value!);
          reviews.set(context.operation.id, {
            binding: reviewBinding(context, state),
            receipt,
            expiresAt: Date.now() + 15 * 60_000,
          });
        } finally {
          if (cleanup) await deps.host.cleanup(cleanup);
        }
      }
      const existing = await deps.host.findOpen({
        repository: state.repository,
        sourceBranch: state.inspection.sourceBranch!,
        baseBranch: state.input.baseBranch,
        operationId: context.operation.id,
        signal: context.signal,
      });
      if (existing)
        assertPullRequest(existing, {
          repository: state.repository,
          sourceBranch: state.inspection.sourceBranch!,
          baseBranch: state.input.baseBranch,
        });
      const approvalInput = approval(state, existing, receipt);
      // The preflight projection is the exact flat action card eventually
      // presented by the shared permission handler, including JSON escaping.
      capabilityApprovalPayload({
        capabilityId: context.operation.capabilityId,
        capabilityVersion: context.operation.capabilityVersion,
        connectionId: context.operation.connectionId,
        operationId: context.operation.id,
        input: approvalInput,
        forcePrompt: true,
      });
      return {
        approvalInput,
        recoveryIntent: {
          repository: state.repository,
          sourceBranch: state.inspection.sourceBranch!,
          sourceOid: state.inspection.sourceOid,
          baseBranch: state.input.baseBranch,
          title: state.input.title,
          body: state.input.body,
          draft: state.input.draft,
          existingPullRequestId: existing?.id ?? '',
          existingPullRequestUrl: existing?.url ?? '',
          operationId: context.operation.id,
        },
      };
    },
    async execute(context) {
      let publicationAttempted = false;
      try {
        const reviewed = reviews.get(context.operation.id);
        // Consume before awaits. A simultaneous executor call cannot reuse a
        // review receipt, and a failed write never authorizes another attempt.
        reviews.delete(context.operation.id);
        if (deps.reviewCommittedChange && (!reviewed || reviewed.expiresAt <= Date.now()))
          throw new GithubPublicationReviewError('PUBLICATION_REVIEW_REQUIRED');
        const state = await inspect(context);
        if (deps.reviewCommittedChange && reviewed!.binding !== reviewBinding(context, state))
          throw new GithubPublicationReviewError('PUBLICATION_REVIEW_CHANGED');
        const existingBeforeWrite = await deps.host.findOpen({
          repository: state.repository,
          sourceBranch: state.inspection.sourceBranch!,
          baseBranch: state.input.baseBranch,
          operationId: context.operation.id,
          signal: context.signal,
        });
        assertApproved(context, state, existingBeforeWrite, reviewed?.receipt);
        if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
        context.signal.throwIfAborted();
        const bundle = await exportedBundle(context, state);
        let directory: string | undefined;
        let cleanupDirectory: string | undefined;
        try {
          if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
          context.signal.throwIfAborted();
          const reconstructed = await deps.host.reconstruct({
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            sourceOid: state.inspection.sourceOid,
            baseBranch: state.input.baseBranch,
            bundle,
            operationId: context.operation.id,
            signal: context.signal,
            ...(context.assertRuntimeCurrent
              ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
              : {}),
          });
          directory = reconstructed.directory;
          cleanupDirectory = reconstructed.cleanupDirectory ?? directory;
          if (!directory) reject('Host reconstruction failed');
          if (reviewed)
            await reviewed.receipt.assertCurrent(reviewInput(context, state, bundle, directory));
          if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
          context.signal.throwIfAborted();
          publicationAttempted = true;
          await deps.host.push({
            directory,
            sourceBranch: state.inspection.sourceBranch!,
            operationId: context.operation.id,
            signal: context.signal,
            ...(context.assertRuntimeCurrent
              ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
              : {}),
          });
          context.signal.throwIfAborted();
          const existing = await deps.host.findOpen({
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            baseBranch: state.input.baseBranch,
            operationId: context.operation.id,
            signal: context.signal,
            ...(context.assertRuntimeCurrent
              ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
              : {}),
          });
          // A close/replace race after the branch push must never change an
          // approved create into an update (or vice versa).
          assertApproved(context, state, existing, reviewed?.receipt);
          if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
          context.signal.throwIfAborted();
          const pr = assertPullRequest(
            existing
              ? await deps.host.update({
                  repository: state.repository,
                  sourceBranch: state.inspection.sourceBranch!,
                  baseBranch: state.input.baseBranch,
                  pullRequest: existing,
                  title: state.input.title,
                  body: state.input.body,
                  draft: state.input.draft,
                  operationId: context.operation.id,
                  signal: context.signal,
                  ...(context.assertRuntimeCurrent
                    ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
                    : {}),
                })
              : await deps.host.create({
                  repository: state.repository,
                  sourceBranch: state.inspection.sourceBranch!,
                  baseBranch: state.input.baseBranch,
                  title: state.input.title,
                  body: state.input.body,
                  draft: state.input.draft,
                  operationId: context.operation.id,
                  signal: context.signal,
                  ...(context.assertRuntimeCurrent
                    ? { assertRuntimeCurrent: context.assertRuntimeCurrent }
                    : {}),
                }),
            {
              repository: state.repository,
              sourceBranch: state.inspection.sourceBranch!,
              baseBranch: state.input.baseBranch,
            },
          );
          assertRequestedMetadata(pr, state.input);
          const result = output(pr, state.inspection, !existing) as Record<string, JsonValue>;
          if (reviewed)
            result.review = {
              receiptId: reviewed.receipt.receiptId,
              evidenceSha256: reviewed.receipt.evidenceSha256,
              summary: reviewed.receipt.summary,
              ...(reviewed.receipt.reports
                ? { reports: JSON.parse(JSON.stringify(reviewed.receipt.reports)) as JsonValue }
                : {}),
            };
          return { output: result, externalResultId: pr.url };
        } finally {
          if (cleanupDirectory) await deps.host.cleanup(cleanupDirectory);
        }
      } catch (error) {
        if (deps.reviewCommittedChange && !publicationAttempted)
          throw markGithubPublicationNotDispatched(error);
        throw error;
      }
    },
    async verify(context, result) {
      if (context.assertRuntimeCurrent) await context.assertRuntimeCurrent();
      context.signal.throwIfAborted();
      const state = await inspect(context);
      const externalResultId = result.externalResultId;
      if (typeof externalResultId !== 'string') reject('GitHub pull request result is invalid');
      const pr = await deps.host.read({
        repository: state.repository,
        sourceBranch: state.inspection.sourceBranch!,
        baseBranch: state.input.baseBranch,
        externalResultId,
        operationId: context.operation.id,
        signal: context.signal,
      });
      if (!pr) reject('GitHub pull request verification failed');
      assertPullRequest(pr, {
        repository: state.repository,
        sourceBranch: state.inspection.sourceBranch!,
        baseBranch: state.input.baseBranch,
      });
      assertRequestedMetadata(pr, state.input);
      if (!samePullRequestUrl(pr.url, externalResultId))
        reject('GitHub pull request verification failed');
      const verifiedHead = await deps.host.readBranch({
        repository: state.repository,
        sourceBranch: state.inspection.sourceBranch!,
        operationId: context.operation.id,
        signal: context.signal,
      });
      if (verifiedHead !== state.inspection.sourceOid)
        reject('GitHub remote branch does not match the approved commit');
    },
    async recover(operation, signal, assertRuntimeCurrent) {
      if (assertRuntimeCurrent) await assertRuntimeCurrent();
      signal.throwIfAborted();
      const result = operation.recoveryIntent;
      if (!result || Array.isArray(result) || typeof result !== 'object')
        reject('GitHub recovery result is unavailable');
      const repository = result.repository;
      const sourceBranch = result.sourceBranch;
      const sourceOid = result.sourceOid;
      const baseBranch = result.baseBranch;
      const title = result.title;
      const body = result.body;
      const draft = result.draft;
      const existingPullRequestId = result.existingPullRequestId;
      const existingPullRequestUrl = result.existingPullRequestUrl;
      if (
        typeof repository !== 'string' ||
        typeof sourceBranch !== 'string' ||
        typeof sourceOid !== 'string' ||
        typeof baseBranch !== 'string' ||
        typeof title !== 'string' ||
        typeof body !== 'string' ||
        typeof draft !== 'boolean' ||
        typeof existingPullRequestId !== 'string' ||
        typeof existingPullRequestUrl !== 'string' ||
        Boolean(existingPullRequestId) !== Boolean(existingPullRequestUrl) ||
        (existingPullRequestId !== '' && !/^[1-9][0-9]*$/.test(existingPullRequestId)) ||
        !/^[a-f0-9]{40,64}$/i.test(sourceOid) ||
        (operation.externalResultId !== null && typeof operation.externalResultId !== 'string')
      )
        reject('GitHub recovery result is unavailable');
      if (existingPullRequestUrl)
        assertPullRequest(
          {
            repository,
            sourceBranch,
            baseBranch,
            id: existingPullRequestId,
            url: existingPullRequestUrl,
            title,
            body,
            draft,
          },
          { repository, sourceBranch, baseBranch },
        );
      const branchOid = await deps.host.readBranch({
        repository,
        sourceBranch,
        operationId: operation.id,
        signal,
      });
      if (!branchOid || branchOid !== sourceOid)
        throw new CapabilityRecoveryPendingError('GitHub branch recovery remains pending');
      const completeExisting = async (existing: GithubPullRequest, expectedUrl?: string) => {
        assertPullRequest(existing, { repository, sourceBranch, baseBranch });
        if (
          expectedUrl &&
          (existing.id !== existingPullRequestId || !samePullRequestUrl(existing.url, expectedUrl))
        )
          reject('GitHub recovery verification failed');
        // A durable head/base identity is authoritative even if a lost
        // response left metadata stale or changed. Recovery is read-only: it
        // must neither duplicate the POST nor rewrite an existing PR.
        return existing;
      };
      let pr: GithubPullRequest;
      if (existingPullRequestUrl) {
        if (
          operation.externalResultId &&
          !samePullRequestUrl(operation.externalResultId, existingPullRequestUrl)
        )
          reject('GitHub recovery verification failed');
        const existing = await deps.host.read({
          repository,
          sourceBranch,
          baseBranch,
          externalResultId: existingPullRequestUrl,
          operationId: operation.id,
          signal,
        });
        if (!existing)
          throw new CapabilityRecoveryPendingError('GitHub pull request recovery remains pending');
        pr = await completeExisting(existing, existingPullRequestUrl);
      } else if (operation.externalResultId) {
        const existing = await deps.host.read({
          repository,
          sourceBranch,
          baseBranch,
          externalResultId: operation.externalResultId,
          operationId: operation.id,
          signal,
        });
        if (!existing)
          throw new CapabilityRecoveryPendingError('GitHub pull request recovery remains pending');
        pr = await completeExisting(existing);
      } else {
        // A response loss after create has no URL. Search *all* PR states for
        // the exact durable head/base/metadata before ever issuing another POST.
        const existing = await deps.host.read({
          repository,
          sourceBranch,
          baseBranch,
          operationId: operation.id,
          signal,
        });
        if (assertRuntimeCurrent) await assertRuntimeCurrent();
        signal.throwIfAborted();
        if (!existing && deps.reviewCommittedChange)
          throw new CapabilityRecoveryPendingError('GitHub pull request recovery remains pending');
        pr = existing
          ? await completeExisting(existing)
          : await deps.host.create({
              repository,
              sourceBranch,
              baseBranch,
              title,
              body,
              draft,
              operationId: operation.id,
              signal,
              ...(assertRuntimeCurrent ? { assertRuntimeCurrent } : {}),
            });
      }
      assertPullRequest(pr, { repository, sourceBranch, baseBranch });
      if (operation.externalResultId && !samePullRequestUrl(pr.url, operation.externalResultId))
        reject('GitHub recovery verification failed');
      const verified = await deps.host.read({
        repository,
        sourceBranch,
        baseBranch,
        externalResultId: pr.url,
        operationId: operation.id,
        signal,
      });
      if (!verified) throw new CapabilityRecoveryPendingError('GitHub recovery remains pending');
      assertPullRequest(verified, { repository, sourceBranch, baseBranch });
      if (assertRuntimeCurrent) await assertRuntimeCurrent();
      signal.throwIfAborted();
      return { outcome: 'verified' };
    },
  };
}
export const GITHUB_PROTECTED_SOURCE_BRANCH_PATTERNS = Object.freeze([
  'main',
  'master',
  'release/*',
  'hotfix/*',
]);
export function isProtectedGithubSourceBranch(value: string): boolean {
  return GITHUB_PROTECTED_SOURCE_BRANCH_PATTERNS.some((pattern) =>
    pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern,
  );
}
