import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  GithubHostPublisher,
  GithubPullRequest,
  GithubSandboxInspection,
  GithubSandboxTransport,
} from './github-publish-pr.js';

const exec = promisify(execFile);
const safeSandbox = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safePath = /^\/sandbox\/workspaces\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const safeBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const safeRepository =
  /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

export interface OpenShellControlRunner {
  (
    args: readonly string[],
    options: { signal: AbortSignal; maxOutputBytes: number },
  ): Promise<string>;
}

function checked(value: string, expression: RegExp, message: string) {
  if (!expression.test(value)) throw new Error(message);
  return value;
}
function lines(value: string) {
  return value.replace(/\r/g, '').split('\n').filter(Boolean);
}
function commandFailure(): never {
  throw new Error('OpenShell Git control command failed');
}

/**
 * Controller transport for a retained OpenShell sandbox. Every executable and
 * argument shape is code-owned. The only shell fragment is a constant bundle
 * encoder; caller values are positional arguments and are validated first.
 */
export class OpenShellGithubSandboxTransport implements GithubSandboxTransport {
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
    checked(repositoryPath, safePath, 'Repository path is invalid');
    try {
      const script =
        'set -eu; repo="$1"; shift; [ "$(realpath -e "$repo")" = "$repo" ]; cd -P "$repo"; [ "$PWD" = "$repo" ]; exec /usr/bin/git "$@"';
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
          script,
          'mitzo-github-git',
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
    const [status, sourceOid, source, origin, count, defaultRef, files] = await Promise.all([
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
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        input.signal,
      ),
      this.git(
        input.sandboxName,
        input.repositoryPath,
        [
          '-c',
          'core.quotepath=true',
          'diff',
          '--name-only',
          '--no-renames',
          `origin/${input.baseBranch}..HEAD`,
        ],
        input.signal,
      ),
    ]);
    const sourceBranch = source.trim();
    const defaultBranch = defaultRef.trim().replace(/^origin\//, '');
    const commitsAhead = Number(count.trim());
    if (
      !safeBranch.test(sourceBranch) ||
      !safeBranch.test(defaultBranch) ||
      !Number.isSafeInteger(commitsAhead) ||
      commitsAhead < 0
    )
      throw new Error('OpenShell Git inspection is invalid');
    const changedFiles = lines(files);
    // Git's quotePath output makes non-text path bytes visible as escapes. A
    // literal newline would make the summary ambiguous and is rejected.
    if (changedFiles.some((file) => file.length > 1024 || file.includes('\0')))
      throw new Error('OpenShell Git inspection is invalid');
    return {
      canonicalRepositoryPath: input.repositoryPath,
      status,
      sourceBranch,
      sourceOid: sourceOid.trim(),
      defaultBranch,
      originUrl: origin.trim(),
      commitsAhead,
      changedFiles,
      sourceBranchProtected:
        sourceBranch === defaultBranch || sourceBranch === 'main' || sourceBranch === 'master',
      symlinkFree: true,
    };
  }
  async exportBundle(input: {
    sandboxName: string;
    repositoryPath: string;
    sourceBranch: string;
    sourceOid: string;
    baseBranch: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<Buffer> {
    checked(input.sandboxName, safeSandbox, 'Sandbox identity is invalid');
    checked(input.repositoryPath, safePath, 'Repository path is invalid');
    checked(input.sourceBranch, safeBranch, 'Source branch is invalid');
    checked(input.baseBranch, safeBranch, 'Base branch is invalid');
    if (!/^[a-f0-9]{40,64}$/i.test(input.sourceOid)) throw new Error('Source commit is invalid');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
      throw new Error('Bundle limit is invalid');
    // `git bundle -` is binary. Encode inside the sandbox so the control CLI
    // only transports bounded text and cannot corrupt NUL-containing objects.
    const script =
      'set -eu; repo="$1"; base="$2"; branch="$3"; oid="$4"; [ "$(realpath -e "$repo")" = "$repo" ]; cd -P "$repo"; [ "$PWD" = "$repo" ]; [ "$(/usr/bin/git rev-parse HEAD)" = "$oid" ]; /usr/bin/git bundle create - "origin/$base..$branch" | base64 | tr -d "\\n"';
    let encoded: string;
    try {
      encoded = await this.run(
        [
          'sandbox',
          '--workspace',
          this.workspace,
          'exec',
          '--name',
          input.sandboxName,
          '--no-tty',
          '--timeout',
          '60',
          '--',
          '/bin/sh',
          '-c',
          script,
          'mitzo-github-export',
          input.repositoryPath,
          input.baseBranch,
          input.sourceBranch,
          input.sourceOid,
        ],
        // Base64 expansion plus a short command envelope.
        { signal: input.signal, maxOutputBytes: Math.ceil(input.maxBytes * 1.37) + 4096 },
      );
    } catch {
      return commandFailure();
    }
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(encoded))
      throw new Error('OpenShell bundle export is invalid');
    const bundle = Buffer.from(encoded.replace(/\s/g, ''), 'base64');
    if (!bundle.length || bundle.length > input.maxBytes)
      throw new Error('OpenShell bundle export exceeds limit');
    return bundle;
  }
}

function gitEnvironment() {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: token ? '2' : '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    ...(token
      ? {
          // Git reads this controller-only environment through a fixed helper;
          // the token is never an argv value, remote URL, log, or sandbox input.
          GITHUB_TOKEN: token,
          GH_TOKEN: token,
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1:
            '!f() { echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f',
        }
      : {}),
  };
}
async function host(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBuffer = 128 * 1024,
) {
  try {
    return await exec(command, [...args], {
      env: gitEnvironment(),
      signal,
      maxBuffer,
      windowsHide: true,
    });
  } catch (error) {
    // `git`/`gh` errors may include an authenticated remote URL or HTTP
    // diagnostics. Preserve neither across the capability boundary.
    if (
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /\b404\b/.test(error.stderr)
    )
      throw new GithubNotFoundError(error);
    throw new Error('GitHub host operation failed', { cause: error });
  }
}
export type GithubHostCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;
class GithubNotFoundError extends Error {
  constructor(cause: unknown) {
    super('GitHub resource not found', { cause });
  }
}
export function parseGithubPullRequest(value: unknown): GithubPullRequest | null {
  const parsed = z
    .object({
      html_url: z.string(),
      number: z.number().int().positive(),
      title: z.string(),
      body: z.string().nullable(),
      draft: z.boolean(),
      head: z.object({ ref: z.string() }),
      base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
    })
    .safeParse(value);
  return parsed.success
    ? {
        url: parsed.data.html_url,
        // REST /pulls/{number} is addressed by the repository-local PR number;
        // GitHub's opaque database `id` is not a valid path identifier.
        id: String(parsed.data.number),
        title: parsed.data.title,
        body: parsed.data.body ?? '',
        draft: parsed.data.draft,
        sourceBranch: parsed.data.head.ref,
        baseBranch: parsed.data.base.ref,
        repository: parsed.data.base.repo.full_name.toLowerCase(),
      }
    : null;
}

/** Host adapter: isolated checkout, no hooks/local config, explicit non-force push. */
export class GitHubCliHostPublisher implements GithubHostPublisher {
  private readonly cleanupParents = new Set<string>();
  constructor(private readonly runHost: GithubHostCommandRunner = host) {}
  async policy(input: { repository: string; sourceBranch: string; signal: AbortSignal }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    checked(input.sourceBranch, safeBranch, 'Source branch is invalid');
    const repository = await this.runHost(
      'gh',
      ['api', '--method', 'GET', `repos/${input.repository}`],
      input.signal,
    );
    let branch: { stdout: string } | null;
    try {
      branch = await this.runHost(
        'gh',
        ['api', '--method', 'GET', `repos/${input.repository}/branches/${input.sourceBranch}`],
        input.signal,
      );
    } catch (error) {
      if (!(error instanceof GithubNotFoundError)) throw error;
      branch = null;
    }
    const repo = z.object({ default_branch: z.string() }).safeParse(JSON.parse(repository.stdout));
    const source = branch
      ? z.object({ protected: z.boolean() }).safeParse(JSON.parse(branch.stdout))
      : undefined;
    if (!repo.success || (source && !source.success) || !safeBranch.test(repo.data.default_branch))
      throw new Error('GitHub repository policy is invalid');
    return {
      defaultBranch: repo.data.default_branch,
      sourceBranchProtected: source?.data.protected ?? false,
    };
  }
  async reconstruct(input: {
    repository: string;
    sourceBranch: string;
    sourceOid: string;
    baseBranch: string;
    bundle: Buffer;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    checked(input.sourceBranch, safeBranch, 'Source branch is invalid');
    checked(input.baseBranch, safeBranch, 'Base branch is invalid');
    const parent = await mkdtemp(join(tmpdir(), 'mitzo-github-publish-'));
    await chmod(parent, 0o700);
    const directory = join(parent, 'checkout');
    try {
      const bundlePath = join(parent, 'commits.bundle');
      await writeFile(bundlePath, input.bundle, { mode: 0o600 });
      await this.runHost(
        'git',
        ['clone', '--no-checkout', `https://github.com/${input.repository}.git`, directory],
        input.signal,
      );
      await this.runHost(
        'git',
        [
          '-C',
          directory,
          'fetch',
          bundlePath,
          `${input.sourceBranch}:refs/heads/${input.sourceBranch}`,
        ],
        input.signal,
      );
      const fetched = await this.runHost(
        'git',
        ['-C', directory, 'rev-parse', `refs/heads/${input.sourceBranch}`],
        input.signal,
      );
      if (fetched.stdout.trim() !== input.sourceOid)
        throw new Error('Host bundle source does not match approved commit');
      await this.runHost(
        'git',
        ['-C', directory, 'symbolic-ref', 'HEAD', `refs/heads/${input.sourceBranch}`],
        input.signal,
      );
      // Do not checkout repository content. Fetching the verified bundle into
      // a clean clone applies the commits without running smudge filters,
      // hooks, package scripts, or repository-controlled code.
      this.cleanupParents.add(parent);
      return { directory, cleanupDirectory: parent };
    } catch (error) {
      await rm(parent, { recursive: true, force: true });
      throw error;
    }
  }
  async push(input: {
    directory: string;
    sourceBranch: string;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.sourceBranch, safeBranch, 'Source branch is invalid');
    // No `--force`, no refspec supplied by a model, and no default branch name.
    await this.runHost(
      'git',
      ['-C', input.directory, 'push', 'origin', `HEAD:refs/heads/${input.sourceBranch}`],
      input.signal,
    );
  }
  async findOpen(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    const owner = input.repository.split('/')[0]!;
    const { stdout } = await this.runHost(
      'gh',
      [
        'api',
        '--method',
        'GET',
        `repos/${input.repository}/pulls`,
        '-f',
        `head=${owner}:${input.sourceBranch}`,
        '-f',
        `base=${input.baseBranch}`,
        '-f',
        'state=open',
      ],
      input.signal,
    );
    const list = z.array(z.unknown()).safeParse(JSON.parse(stdout));
    if (!list.success || list.data.length > 1)
      throw new Error('GitHub pull request lookup is invalid');
    return list.data.length === 0 ? null : parseGithubPullRequest(list.data[0]);
  }
  async create(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    title: string;
    body: string;
    draft: boolean;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    const { stdout } = await this.runHost(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `repos/${input.repository}/pulls`,
        '-f',
        `head=${input.sourceBranch}`,
        '-f',
        `base=${input.baseBranch}`,
        '-f',
        `title=${input.title}`,
        '-f',
        `body=${input.body}`,
        '-F',
        `draft=${input.draft ? 'true' : 'false'}`,
      ],
      input.signal,
    );
    const value = parseGithubPullRequest(JSON.parse(stdout));
    if (!value) throw new Error('GitHub pull request result is invalid');
    return value;
  }
  async update(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    pullRequestId: string;
    title: string;
    body: string;
    draft: boolean;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    if (!/^[1-9][0-9]*$/.test(input.pullRequestId))
      throw new Error('Pull request identity is invalid');
    const { stdout } = await this.runHost(
      'gh',
      [
        'api',
        '--method',
        'PATCH',
        `repos/${input.repository}/pulls/${input.pullRequestId}`,
        '-f',
        `title=${input.title}`,
        '-f',
        `body=${input.body}`,
        '-F',
        `draft=${input.draft ? 'true' : 'false'}`,
      ],
      input.signal,
    );
    const value = parseGithubPullRequest(JSON.parse(stdout));
    if (!value) throw new Error('GitHub pull request result is invalid');
    return value;
  }
  async read(input: {
    repository: string;
    sourceBranch: string;
    baseBranch: string;
    externalResultId?: string;
    operationId: string;
    signal: AbortSignal;
  }) {
    if (!input.externalResultId) return this.findOpen(input);
    let url: URL;
    try {
      url = new URL(input.externalResultId);
    } catch {
      throw new Error('GitHub pull request result is invalid');
    }
    const expected = `/${input.repository}/pull/`;
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      !url.pathname.toLowerCase().startsWith(expected.toLowerCase())
    )
      throw new Error('GitHub pull request result is invalid');
    const number = url.pathname.slice(expected.length);
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error('GitHub pull request result is invalid');
    const { stdout } = await this.runHost(
      'gh',
      ['api', '--method', 'GET', `repos/${input.repository}/pulls/${number}`],
      input.signal,
    );
    const existing = parseGithubPullRequest(JSON.parse(stdout));
    if (!existing || existing.url !== input.externalResultId) return null;
    return existing;
  }
  async readBranch(input: {
    repository: string;
    sourceBranch: string;
    operationId: string;
    signal: AbortSignal;
  }) {
    checked(input.repository, safeRepository, 'Repository is invalid');
    checked(input.sourceBranch, safeBranch, 'Source branch is invalid');
    const { stdout } = await this.runHost(
      'git',
      [
        'ls-remote',
        `https://github.com/${input.repository}.git`,
        `refs/heads/${input.sourceBranch}`,
      ],
      input.signal,
    );
    const row = stdout.trim();
    if (!row) return null;
    const oid = row.split(/\s+/)[0];
    if (!oid || !/^[a-f0-9]{40,64}$/i.test(oid)) throw new Error('GitHub branch lookup is invalid');
    return oid;
  }
  async cleanup(directory: string) {
    const root = join(tmpdir(), 'mitzo-github-publish-');
    if (!directory.startsWith(root) || directory === root || !this.cleanupParents.delete(directory))
      throw new Error('Host checkout cleanup refused');
    await rm(directory, { recursive: true, force: true });
  }
}
