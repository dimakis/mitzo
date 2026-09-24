#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { basename, dirname, join, resolve } from 'path';
import {
  generateWorktreeManifest,
  writeWorktreeManifest,
  type WorktreeManifest,
  type WorktreePullRequestEvidence,
} from '../server/worktree-manifest.js';
import {
  createWorktreeRecoveryPackage,
  rehearseWorktreeRecovery,
} from '../server/worktree-recovery.js';
import { readIndex } from '../server/session-index.js';
import {
  parseWorktreeEvidenceArgs,
  type WorktreeEvidenceArgs,
} from '../server/worktree-evidence-args.js';

function githubRemote(repository: string): boolean {
  try {
    const remote = execFileSync('git', ['-C', repository, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return /github\.com[/:]/.test(remote);
  } catch {
    return false;
  }
}

function pullRequests(repository: string): WorktreePullRequestEvidence[] {
  const output = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,url,state,headRefName'],
    { cwd: repository, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return (JSON.parse(output) as Array<Omit<WorktreePullRequestEvidence, 'repository'>>).map(
    (pullRequest) => ({ repository: resolve(repository), ...pullRequest }),
  );
}

function writePrivateJson(path: string, value: unknown): void {
  const output = resolve(path);
  const directory = dirname(output);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(directory, `.${basename(output)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, output);
  chmodSync(output, 0o600);
}

export function runWorktreeEvidence(command: WorktreeEvidenceArgs): unknown {
  if (command.command === 'manifest') {
    const pullRequestLookupByRepository = new Map<string, 'complete' | 'unavailable'>();
    const prEvidence = command.includePullRequests
      ? command.repositories.flatMap((repository) => {
          const absolute = resolve(repository);
          if (!githubRemote(repository)) {
            pullRequestLookupByRepository.set(absolute, 'unavailable');
            return [];
          }
          const evidence = pullRequests(repository);
          pullRequestLookupByRepository.set(absolute, 'complete');
          return evidence;
        })
      : undefined;
    const indexedActiveSessionIds = command.repositories.flatMap((repository) =>
      readIndex(repository)
        .filter((session) => session.status === 'active')
        .map((session) => session.id),
    );
    const manifest = generateWorktreeManifest({
      repositories: command.repositories,
      inboxDirectories: command.inboxDirectories,
      activeSessionIds: new Set([...indexedActiveSessionIds, ...command.activeSessionIds]),
      pullRequests: prEvidence,
      pullRequestLookupByRepository: command.includePullRequests
        ? pullRequestLookupByRepository
        : undefined,
      includeRegisteredOutsideManagedRoots: true,
    });
    writeWorktreeManifest(manifest, command.output);
    return { output: resolve(command.output), entries: manifest.entries.length };
  }
  if (command.command === 'package') {
    const manifest = JSON.parse(readFileSync(command.manifest, 'utf8')) as WorktreeManifest;
    const matches = manifest.entries.filter((entry) => entry.sessionId === command.sessionId);
    if (matches.length !== 1) {
      throw new Error(`expected exactly one manifest entry for session ${command.sessionId}`);
    }
    const result = createWorktreeRecoveryPackage({
      entry: matches[0],
      destinationRoot: command.destinationRoot,
      selectedUntrackedPaths: command.selectedUntrackedPaths,
      packageName: command.packageName,
    });
    matches[0].recoveryLocation = result.path;
    writeWorktreeManifest(manifest, command.manifest);
    return { package: result.path, sessionId: command.sessionId };
  }
  const rehearsal = rehearseWorktreeRecovery({
    packagePath: command.packagePath,
    destination: command.destination,
  });
  const report = { ...rehearsal, verifiedAt: new Date().toISOString() };
  writePrivateJson(command.output, report);
  return { report: resolve(command.output), ...rehearsal };
}

function main(): void {
  try {
    const result = runWorktreeEvidence(parseWorktreeEvidenceArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
