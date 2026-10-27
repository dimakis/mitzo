import { buildPermissionHandler, type SessionRegistry } from '@mitzo/harness';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { isGitBranchName } from './git-branch.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import { getConnectionsRuntime } from './connections-runtime.js';
import { githubRepositoryConnections } from './github-repository-connections.js';
import { captureRepositoryHostGit } from './local-repository-host-git.js';
import {
  validateLocalRepositoryRemote,
  type LocalRepositoryRemoteGit,
  type LocalRepositoryRemoteRequest,
} from './local-repository-base.js';

/** The acquisition capability cannot run arbitrary Git against the host account. */
function assertAcquisitionCommand(
  args: readonly string[],
  request: LocalRepositoryRemoteRequest,
): void {
  const safeConfig = new Set([
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'credential.helper=',
    'http.followRedirects=false',
    'protocol.allow=never',
    'protocol.https.allow=always',
    'protocol.ssh.allow=always',
  ]);
  let index = 0;
  while (args[index] === '-c') {
    if (!safeConfig.has(args[index + 1])) throw Error('Repository acquisition command unavailable');
    index += 2;
  }
  let gitDirectory = false;
  if (args[index] === '--git-dir' && args[index + 1] === join(request.directory, '.git')) {
    gitDirectory = true;
    index += 2;
  }
  const command = args.slice(index);
  const matches = (...expected: string[]) => isDeepStrictEqual(command, expected);
  const valid = !gitDirectory
    ? matches('ls-remote', '--symref', '--', request.url, 'HEAD') ||
      matches('init', '--quiet', '--template=', '--initial-branch=mitzo-acquire', request.directory)
    : matches('rev-parse', '--verify', '--end-of-options', 'refs/mitzo/base^{commit}') ||
      matches('symbolic-ref', 'HEAD', 'refs/heads/mitzo-acquire') ||
      (command.length === 3 &&
        command[0] === 'update-ref' &&
        command[1] === 'refs/heads/mitzo-acquire' &&
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(command[2])) ||
      (() => {
        const selected = /^\+(.+):refs\/mitzo\/base$/.exec(command[6] ?? '')?.[1];
        return (
          !!selected &&
          matches(
            'fetch',
            '--no-tags',
            '--depth=1',
            '--no-write-fetch-head',
            '--',
            request.url,
            `+${selected}:refs/mitzo/base`,
          ) &&
          (request.base.kind === 'ref'
            ? selected === request.base.ref
            : selected.startsWith('refs/heads/') && isGitBranchName(selected))
        );
      })();
  if (!valid) throw Error('Repository acquisition command unavailable');
}

/** Current host/account adapter for remote reads into private acquisition scratch.
 * This does not authorize creation/adoption/retirement of a task workspace. */
export async function authorizeNativeLocalRepositoryRemote(
  context: NativeHostToolContext,
  request: LocalRepositoryRemoteRequest,
  registry: SessionRegistry,
): Promise<LocalRepositoryRemoteGit> {
  const unavailable = () => Error('Current host repository acquisition unavailable');
  const url = new URL(validateLocalRepositoryRemote(request.url));
  const github = url.hostname === 'github.com';
  if (
    github &&
    (url.port ||
      (url.username && url.username !== 'git') ||
      !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/.test(url.pathname))
  )
    throw unavailable();
  const repository = github
    ? url.pathname
        .slice(1)
        .replace(/\.git$/, '')
        .toLowerCase()
    : `${url.host}${url.pathname}`;
  const remote = github ? `https://github.com/${repository}.git` : url.href;
  const directory = request.directory;
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    !Number.isSafeInteger(request.deadline) ||
    request.deadline <= Date.now()
  )
    throw unavailable();
  const signal = AbortSignal.any([context.signal, request.signal]);
  const parent = dirname(directory);
  await context.assertCurrent();
  const identity = await lstat(parent, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || (await realpath(parent)) !== parent)
    throw unavailable();
  const current = async () => {
    signal.throwIfAborted();
    if (Date.now() >= request.deadline) throw unavailable();
    await context.assertCurrent();
    const observed = await lstat(parent, { bigint: true });
    if (
      observed.dev !== identity.dev ||
      observed.ino !== identity.ino ||
      (await realpath(parent)) !== parent
    )
      throw unavailable();
    context.assertCurrentSync();
  };
  await current();
  const host = captureRepositoryHostGit(remote);
  const hostOptions = { directory, signal, deadline: request.deadline };
  const runtime = github ? getConnectionsRuntime() : null;
  const selected = githubRepositoryConnections(
    runtime?.store.list('operator') ?? [],
    context.accountBinding.accountId,
    repository,
  );
  if (selected.length > 1) throw unavailable();
  const connection = selected[0];
  const revision = connection?.revision;
  const assertAccount = async () => {
    if (!github) {
      await current();
      return;
    }
    if (getConnectionsRuntime() !== runtime) throw unavailable();
    const eligible = runtime
      ? githubRepositoryConnections(
          runtime.store.list('operator'),
          context.accountBinding.accountId,
          repository,
        )
      : [];
    const retained = connection ? runtime?.store.get(connection.id) : undefined;
    if (
      connection &&
      (!runtime ||
        retained?.revision !== revision ||
        retained?.status !== 'active' ||
        eligible.length !== 1 ||
        eligible[0].id !== connection.id ||
        retained.identity?.toLowerCase() !== login.toLowerCase() ||
        !(await runtime.verifyGithubPublishingIdentity?.(connection.id, signal, revision)))
    )
      throw unavailable();
    if ((await host.identity(hostOptions)).toLowerCase() !== login.toLowerCase())
      throw unavailable();
    await current();
  };
  if (!connection) {
    const input = Object.freeze({
      operation: 'acquire-repository-base',
      repository,
      remote,
      identity: github
        ? 'current host GitHub account'
        : url.protocol === 'ssh:'
          ? 'host SSH agent'
          : 'host HTTPS credential store',
      directory,
      base: request.base,
    });
    const result = await buildPermissionHandler(context.clientId, registry)(
      context.toolName,
      input,
      {
        signal,
        toolUseID: context.callId,
        forcePrompt: true,
        allowSessionGrant: false,
        rememberSessionGrant: false,
        approvalScope: 'request',
        nativeApproval: Object.freeze({
          allowSessionScope: false,
          assertCurrentSync: () => {
            signal.throwIfAborted();
            context.assertCurrentSync();
          },
        }),
      },
    );
    if (
      result.behavior !== 'allow' ||
      result.decisionClassification !== 'user_temporary' ||
      !isDeepStrictEqual(result.updatedInput, input)
    )
      throw unavailable();
    await current();
  }
  // Identity verification itself is a credentialed network read. Perform it
  // only under an existing connection or the explicit acquisition consent.
  const login = github ? await host.identity(hostOptions) : '';
  await current();
  await assertAccount();
  return async (args, operationSignal) => {
    assertAcquisitionCommand(args, request);
    operationSignal.throwIfAborted();
    await current();
    await assertAccount();
    const output = await host.run(
      args.map((arg) => (arg === request.url ? remote : arg)),
      {
        ...hostOptions,
        signal: AbortSignal.any([signal, operationSignal]),
      },
    );
    await current();
    operationSignal.throwIfAborted();
    return output;
  };
}
