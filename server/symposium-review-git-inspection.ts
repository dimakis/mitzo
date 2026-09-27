import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import {
  githubGitBoundaryScript,
  type OpenShellControlRunner,
} from './connections/capabilities/github-publish-pr-transport.js';
import type { GithubSandboxInspection } from './connections/capabilities/github-publish-pr.js';

const safeSandbox = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
function checked(value: string, expression: RegExp, message: string) {
  if (!expression.test(value)) throw new Error(message);
}
function lines(value: string) {
  return value.replace(/\r/g, '').split('\n').filter(Boolean);
}
function commandFailure(): never {
  throw new Error('OpenShell Git control command failed');
}

/** Read-only artifact inspection, deliberately separate from the reviewed publisher
 * transport. The root and Git argv are code-owned; no export or mutation method exists.
 * Reuses the unchanged publisher's Git-directory boundary script for path custody. */
export class OpenShellSymposiumGitInspection {
  constructor(
    private readonly run: OpenShellControlRunner,
    private readonly workspace: string,
  ) {}
  private async git(
    sandboxName: string,
    repositoryPath: string,
    args: readonly string[],
    signal: AbortSignal,
    maxOutputBytes = 128 * 1024,
  ) {
    checked(sandboxName, safeSandbox, 'Sandbox identity is invalid');
    if (
      repositoryPath !== SYMPOSIUM_ARTIFACT_TARGET &&
      !repositoryPath.startsWith(SYMPOSIUM_ARTIFACT_TARGET + '/')
    )
      throw new Error('Repository path is invalid');
    checked(this.workspace, safeSandbox, 'OpenShell workspace is invalid');
    try {
      return await this.run(
        [
          'sandbox',
          '--workspace',
          this.workspace,
          'exec',
          '--name',
          sandboxName,
          '--no-tty',
          '--timeout',
          '30',
          '--',
          '/bin/sh',
          '-c',
          githubGitBoundaryScript,
          'mitzo-github-git',
          SYMPOSIUM_ARTIFACT_TARGET,
          repositoryPath,
          ...args,
        ],
        { signal, maxOutputBytes },
      );
    } catch {
      return commandFailure();
    }
  }
  async inspect(input: {
    sandboxName: string;
    repositoryPath: string;
    baseBranch: string;
    signal: AbortSignal;
  }): Promise<GithubSandboxInspection> {
    checked(input.baseBranch, safeBranch, 'Base branch is invalid');
    const [status, sourceOid, source, origin, count, files] = await Promise.all([
      this.git(
        input.sandboxName,
        input.repositoryPath,
        ['status', '--porcelain=v1', '--untracked-files=all'],
        input.signal,
      ),
      this.git(input.sandboxName, input.repositoryPath, ['rev-parse', 'HEAD'], input.signal),
      this.git(
        input.sandboxName,
        input.repositoryPath,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        input.signal,
      ),
      this.git(
        input.sandboxName,
        input.repositoryPath,
        ['remote', 'get-url', 'origin'],
        input.signal,
      ),
      this.git(
        input.sandboxName,
        input.repositoryPath,
        ['rev-list', '--count', `origin/${input.baseBranch}..HEAD`],
        input.signal,
      ),
      this.git(
        input.sandboxName,
        input.repositoryPath,
        [
          '-c',
          'core.quotepath=true',
          'diff-tree',
          '--root',
          '--no-commit-id',
          '-r',
          '--name-only',
          '--no-renames',
          `origin/${input.baseBranch}..HEAD`,
        ],
        input.signal,
      ),
    ]);
    const sourceBranch = source.trim();
    const commitsAhead = Number(count.trim());
    if (!safeBranch.test(sourceBranch) || !Number.isSafeInteger(commitsAhead) || commitsAhead < 0)
      throw new Error('OpenShell Git inspection is invalid');
    // `diff-tree` walks every exported commit, so this approved union includes
    // paths later deleted and cannot be narrowed to the final tree diff.
    const changedFiles = [...new Set(lines(files))].sort();
    // Git's quotePath output makes non-text path bytes visible as escapes. A
    // literal newline would make the summary ambiguous and is rejected.
    if (changedFiles.some((file) => file.length > 1024 || file.includes('\0')))
      throw new Error('OpenShell Git inspection is invalid');
    return {
      canonicalRepositoryPath: input.repositoryPath,
      status,
      sourceBranch,
      sourceOid: sourceOid.trim(),
      // Default/protected status is host-authoritative; this local checkout
      // need not have an origin/HEAD symbolic ref.
      defaultBranch: '',
      originUrl: origin.trim(),
      commitsAhead,
      changedFiles,
      sourceBranchProtected: false,
      symlinkFree: true,
    };
  }
  /** A bounded NUL-delimited committed tree, read through the same Git boundary. */
  async committedTree(input: {
    sandboxName: string;
    repositoryPath: string;
    sourceOid: string;
    signal: AbortSignal;
  }): Promise<string> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.sourceOid))
      throw new Error('Source commit is invalid');
    return this.git(
      input.sandboxName,
      input.repositoryPath,
      ['ls-tree', '-r', '-z', '--full-tree', input.sourceOid],
      input.signal,
      1024 * 1024,
    );
  }
}
