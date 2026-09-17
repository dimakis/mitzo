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
  }): Promise<{ directory: string; cleanupDirectory?: string }>;
  push(input: {
    directory: string;
    sourceBranch: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<void>;
  findOpen(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    operationId: string;
    signal: AbortSignal;
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
  }): Promise<GithubPullRequest>;
  update(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    pullRequestId: string;
    pullRequestUrl: string;
    title: string;
    body: string;
    draft: boolean;
    operationId: string;
    signal: AbortSignal;
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
}

type Input = Readonly<{
  connectionId: string;
  repositoryPath: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
}>;

const branch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const repository =
  /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

function reject(message: string): never {
  throw new Error(message);
}
function validBranch(value: string) {
  return (
    branch.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('.') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock') &&
    !value.includes('@{')
  );
}
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
    url.hostname.toLowerCase() !== 'github.com' ||
    url.pathname.toLowerCase() !== `/${expected.repository}/pull/${value.id}`.toLowerCase()
  )
    return reject('GitHub pull request result is invalid');
  return value;
}
function output(pr: GithubPullRequest, inspection: GithubSandboxInspection): JsonValue {
  return {
    repository: pr.repository,
    sourceBranch: pr.sourceBranch,
    baseBranch: pr.baseBranch,
    pullRequestUrl: pr.url,
    pullRequestId: pr.id,
    commitsAhead: inspection.commitsAhead,
    changedFiles: inspection.changedFiles.slice(0, GITHUB_PUBLISH_MAX_CHANGED_FILES),
  };
}
function assertRequestedMetadata(pr: GithubPullRequest, input: Input) {
  if (pr.title !== input.title || pr.body !== input.body || pr.draft !== input.draft)
    reject('GitHub pull request verification failed');
}

/**
 * Reviewed executor factory. All mutation dependencies are injected, which
 * keeps the security boundary testable and avoids a credential-bearing module
 * singleton.
 */
export function createGithubPublishPrExecutor(
  deps: GithubPublishPrDependencies,
): CapabilityExecutor {
  const inspect = async (context: CapabilityExecutionContext) => {
    const input = inputOf(context.input);
    if (input.connectionId !== context.operation.connectionId) reject('GitHub connection changed');
    if (!validBranch(input.baseBranch)) reject('Base branch is invalid');
    const conversation = deps.resolveConversation(context.operation);
    const config = deps.resolvePublicConfig(context.operation);
    if (!conversation || !config) reject('GitHub publish access is unavailable');
    const repositoryPath = canonicalRepositoryPath(conversation.workspace, input.repositoryPath);
    const inspection = await deps.sandbox.inspect({
      sandboxName: conversation.sandboxName,
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
    return { input, conversation, repositoryPath, inspection, repository: repo };
  };
  const approval = (
    state: Awaited<ReturnType<typeof inspect>>,
    existing: GithubPullRequest | null,
  ) => ({
    ...state.input,
    repository: state.repository,
    sourceBranch: state.inspection.sourceBranch!,
    sourceOid: state.inspection.sourceOid,
    baseBranch: state.input.baseBranch,
    commitCount: String(state.inspection.commitsAhead),
    changedFiles: JSON.stringify(state.inspection.changedFiles),
    existingPullRequest: existing ? 'update' : 'create',
  });
  const assertApproved = (
    context: CapabilityExecutionContext,
    state: Awaited<ReturnType<typeof inspect>>,
    existing: GithubPullRequest | null,
  ) => {
    // CapabilityService always supplies this field after durable preflight.
    // Keeping direct executor unit tests possible does not weaken that service boundary.
    if (
      context.approvalInput &&
      canonicalJson(context.approvalInput) !== canonicalJson(approval(state, existing))
    )
      reject('GitHub repository changed after approval');
  };
  return {
    async preflight(context) {
      const state = await inspect(context);
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
      const approvalInput = approval(state, existing);
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
          operationId: context.operation.id,
        },
      };
    },
    async execute(context) {
      const state = await inspect(context);
      const existingBeforeWrite = await deps.host.findOpen({
        repository: state.repository,
        sourceBranch: state.inspection.sourceBranch!,
        baseBranch: state.input.baseBranch,
        operationId: context.operation.id,
        signal: context.signal,
      });
      assertApproved(context, state, existingBeforeWrite);
      const bundle = await deps.sandbox.exportBundle({
        sandboxName: state.conversation.sandboxName,
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
        bundle.length === 0 ||
        bundle.length > GITHUB_PUBLISH_MAX_BUNDLE_BYTES
      )
        reject('Committed change export exceeds the safety limit');
      let directory: string | undefined;
      let cleanupDirectory: string | undefined;
      try {
        const reconstructed = await deps.host.reconstruct({
          repository: state.repository,
          sourceBranch: state.inspection.sourceBranch!,
          sourceOid: state.inspection.sourceOid,
          baseBranch: state.input.baseBranch,
          bundle,
          operationId: context.operation.id,
          signal: context.signal,
        });
        directory = reconstructed.directory;
        cleanupDirectory = reconstructed.cleanupDirectory ?? directory;
        if (!directory) reject('Host reconstruction failed');
        await deps.host.push({
          directory,
          sourceBranch: state.inspection.sourceBranch!,
          operationId: context.operation.id,
          signal: context.signal,
        });
        context.signal.throwIfAborted();
        const existing = await deps.host.findOpen({
          repository: state.repository,
          sourceBranch: state.inspection.sourceBranch!,
          baseBranch: state.input.baseBranch,
          operationId: context.operation.id,
          signal: context.signal,
        });
        const pr = assertPullRequest(
          existing
            ? await deps.host.update({
                repository: state.repository,
                sourceBranch: state.inspection.sourceBranch!,
                baseBranch: state.input.baseBranch,
                pullRequestId: existing.id,
                pullRequestUrl: existing.url,
                title: state.input.title,
                body: state.input.body,
                draft: state.input.draft,
                operationId: context.operation.id,
                signal: context.signal,
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
              }),
          {
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            baseBranch: state.input.baseBranch,
          },
        );
        assertRequestedMetadata(pr, state.input);
        return { output: output(pr, state.inspection), externalResultId: pr.url };
      } finally {
        if (cleanupDirectory) await deps.host.cleanup(cleanupDirectory);
      }
    },
    async verify(context, result) {
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
      if (pr.url !== externalResultId) reject('GitHub pull request verification failed');
    },
    async recover(operation, signal) {
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
      if (
        typeof repository !== 'string' ||
        typeof sourceBranch !== 'string' ||
        typeof sourceOid !== 'string' ||
        typeof baseBranch !== 'string' ||
        typeof title !== 'string' ||
        typeof body !== 'string' ||
        typeof draft !== 'boolean' ||
        !/^[a-f0-9]{40,64}$/i.test(sourceOid) ||
        (operation.externalResultId !== null && typeof operation.externalResultId !== 'string')
      )
        reject('GitHub recovery result is unavailable');
      const branchOid = await deps.host.readBranch({
        repository,
        sourceBranch,
        operationId: operation.id,
        signal,
      });
      if (!branchOid || branchOid !== sourceOid)
        throw new CapabilityRecoveryPendingError('GitHub branch recovery remains pending');
      const existing = await deps.host.read({
        repository,
        sourceBranch,
        baseBranch,
        externalResultId: operation.externalResultId ?? undefined,
        operationId: operation.id,
        signal,
      });
      const pr = existing
        ? await deps.host.update({
            repository,
            sourceBranch,
            baseBranch,
            pullRequestId: existing.id,
            pullRequestUrl: existing.url,
            title,
            body,
            draft,
            operationId: operation.id,
            signal,
          })
        : await deps.host.create({
            repository,
            sourceBranch,
            baseBranch,
            title,
            body,
            draft,
            operationId: operation.id,
            signal,
          });
      assertPullRequest(pr, { repository, sourceBranch, baseBranch });
      assertRequestedMetadata(pr, {
        connectionId: operation.connectionId,
        repositoryPath: '',
        baseBranch,
        title,
        body,
        draft,
      });
      if (operation.externalResultId && pr.url !== operation.externalResultId)
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
      assertRequestedMetadata(verified, {
        connectionId: operation.connectionId,
        repositoryPath: '',
        baseBranch,
        title,
        body,
        draft,
      });
      return {
        output: {
          repository: verified.repository,
          sourceBranch: verified.sourceBranch,
          baseBranch: verified.baseBranch,
          pullRequestUrl: verified.url,
          pullRequestId: verified.id,
          sourceOid,
          recovered: true,
        },
        externalResultId: verified.url,
      };
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
