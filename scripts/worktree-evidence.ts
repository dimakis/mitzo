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

interface ManifestCommand {
  command: 'manifest';
  repositories: string[];
  inboxDirectories: string[];
  activeSessionIds: string[];
  includePullRequests: boolean;
  output: string;
}

interface PackageCommand {
  command: 'package';
  manifest: string;
  sessionId: string;
  destinationRoot: string;
  selectedUntrackedPaths: string[];
  packageName?: string;
}

interface RehearseCommand {
  command: 'rehearse';
  packagePath: string;
  destination: string;
  output: string;
}

export type WorktreeEvidenceArgs = ManifestCommand | PackageCommand | RehearseCommand;

function values(args: string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    found.push(value);
    index++;
  }
  return found;
}

function required(args: string[], name: string): string {
  const found = values(args, name);
  if (found.length === 0) throw new Error(`missing ${name}`);
  if (found.length > 1) throw new Error(`${name} may be provided only once`);
  return found[0];
}

function assertKnown(args: string[], known: ReadonlySet<string>): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    if (!known.has(argument)) throw new Error(`unknown option: ${argument}`);
    if (argument !== '--include-prs') index++;
  }
}

export function parseWorktreeEvidenceArgs(args: string[]): WorktreeEvidenceArgs {
  const [command, ...rest] = args;
  if (command === 'manifest') {
    assertKnown(
      rest,
      new Set(['--repo', '--inbox', '--active-session', '--include-prs', '--output']),
    );
    const repositories = values(rest, '--repo');
    if (repositories.length === 0) throw new Error('missing --repo');
    return {
      command,
      repositories,
      inboxDirectories: values(rest, '--inbox'),
      activeSessionIds: values(rest, '--active-session'),
      includePullRequests: rest.includes('--include-prs'),
      output: required(rest, '--output'),
    };
  }
  if (command === 'package') {
    assertKnown(
      rest,
      new Set(['--manifest', '--session', '--destination-root', '--select', '--package-name']),
    );
    const selectedUntrackedPaths = values(rest, '--select');
    if (selectedUntrackedPaths.length === 0) throw new Error('missing --select');
    const packageName = values(rest, '--package-name');
    if (packageName.length > 1) throw new Error('--package-name may be provided only once');
    return {
      command,
      manifest: required(rest, '--manifest'),
      sessionId: required(rest, '--session'),
      destinationRoot: required(rest, '--destination-root'),
      selectedUntrackedPaths,
      ...(packageName[0] ? { packageName: packageName[0] } : {}),
    };
  }
  if (command === 'rehearse') {
    assertKnown(rest, new Set(['--package', '--destination', '--output']));
    return {
      command,
      packagePath: required(rest, '--package'),
      destination: required(rest, '--destination'),
      output: required(rest, '--output'),
    };
  }
  throw new Error('expected manifest, package, or rehearse command');
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
    const prEvidence = command.includePullRequests
      ? command.repositories.flatMap((repository) => pullRequests(repository))
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
