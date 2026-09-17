import { Buffer } from 'node:buffer';
import { posix as path } from 'node:path';
import type { JsonValue } from '../types.js';
import type {
  CapabilityExecutionContext,
  CapabilityExecutor,
  CapabilityOperation,
} from './types.js';

/** A deliberately small binary budget. The sandbox must not become a data exfiltration channel. */
export const GITHUB_PUBLISH_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const GITHUB_PUBLISH_MAX_CHANGED_FILES = 500;

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
  defaultBranch: string;
  /** The exact origin URL observed by Git, not an arbitrary configured URL. */
  originUrl: string;
  commitsAhead: number;
  changedFiles: readonly string[];
  /** A controller-supplied protected-branch decision, evaluated before export/network. */
  sourceBranchProtected: boolean;
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
}

/**
 * Host-only publisher. Its implementation owns controller credentials and is
 * forbidden from placing them in an argument, result, error, or sandbox call.
 */
export interface GithubHostPublisher {
  reconstruct(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    bundle: Buffer;
    operationId: string;
    signal: AbortSignal;
  }): Promise<{ directory: string }>;
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
  read(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    externalResultId?: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<GithubPullRequest | null>;
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
  if (resolved === root || !resolved.startsWith(root + '/'))
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
  if (
    !value ||
    value.repository !== expected.repository ||
    value.sourceBranch !== expected.sourceBranch ||
    value.baseBranch !== expected.baseBranch ||
    typeof value.id !== 'string' ||
    !/^https:\/\/github\.com\/[a-z0-9._-]+\/[a-z0-9._-]+\/pull\/[1-9][0-9]*$/.test(value.url)
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
    if (inspection.canonicalRepositoryPath !== repositoryPath)
      reject('Repository path is ambiguous');
    if (inspection.status !== '') reject('Repository working tree is dirty');
    if (!inspection.sourceBranch || !validBranch(inspection.sourceBranch))
      reject('Repository HEAD is detached');
    if (
      inspection.sourceBranch === inspection.defaultBranch ||
      inspection.sourceBranch === input.baseBranch ||
      inspection.sourceBranchProtected
    )
      reject('Source branch is protected');
    if (!Number.isSafeInteger(inspection.commitsAhead) || inspection.commitsAhead < 1)
      reject('Repository has no commits ahead of base');
    if (
      inspection.changedFiles.length > GITHUB_PUBLISH_MAX_CHANGED_FILES ||
      inspection.changedFiles.some((file) => typeof file !== 'string' || file.length > 1024)
    )
      reject('Changed-file summary is invalid');
    const repo = githubRepositoryFromOrigin(inspection.originUrl);
    if (!allowlist(config, 'allowedRepositories').has(repo)) reject('Repository is not allowed');
    if (!allowlist(config, 'allowedBaseBranches').has(input.baseBranch))
      reject('Base branch is not allowed');
    return { input, conversation, repositoryPath, inspection, repository: repo };
  };
  return {
    async execute(context) {
      const state = await inspect(context);
      const bundle = await deps.sandbox.exportBundle({
        sandboxName: state.conversation.sandboxName,
        repositoryPath: state.repositoryPath,
        sourceBranch: state.inspection.sourceBranch!,
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
      try {
        directory = (
          await deps.host.reconstruct({
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            baseBranch: state.input.baseBranch,
            bundle,
            operationId: context.operation.id,
            signal: context.signal,
          })
        ).directory;
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
          existing ??
            (await deps.host.create({
              repository: state.repository,
              sourceBranch: state.inspection.sourceBranch!,
              baseBranch: state.input.baseBranch,
              title: state.input.title,
              body: state.input.body,
              draft: state.input.draft,
              operationId: context.operation.id,
              signal: context.signal,
            })),
          {
            repository: state.repository,
            sourceBranch: state.inspection.sourceBranch!,
            baseBranch: state.input.baseBranch,
          },
        );
        return { output: output(pr, state.inspection), externalResultId: pr.url };
      } finally {
        if (directory) await deps.host.cleanup(directory);
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
      if (pr.url !== externalResultId) reject('GitHub pull request verification failed');
    },
    async recover(operation, signal) {
      const result = operation.result;
      if (!result || Array.isArray(result) || typeof result !== 'object')
        reject('GitHub recovery result is unavailable');
      const repository = result.repository;
      const sourceBranch = result.sourceBranch;
      const baseBranch = result.baseBranch;
      if (
        typeof repository !== 'string' ||
        typeof sourceBranch !== 'string' ||
        typeof baseBranch !== 'string' ||
        typeof operation.externalResultId !== 'string'
      )
        reject('GitHub recovery result is unavailable');
      const pr = await deps.host.read({
        repository,
        sourceBranch,
        baseBranch,
        externalResultId: operation.externalResultId,
        operationId: operation.id,
        signal,
      });
      if (!pr) reject('GitHub recovery verification failed');
      assertPullRequest(pr, { repository, sourceBranch, baseBranch });
      if (pr.url !== operation.externalResultId) reject('GitHub recovery verification failed');
    },
  };
}
