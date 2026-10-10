export interface ManifestCommand {
  command: 'manifest';
  repositories: string[];
  inboxDirectories: string[];
  activeSessionIds: string[];
  includePullRequests: boolean;
  output: string;
}

export interface PackageCommand {
  command: 'package';
  manifest: string;
  sessionId: string;
  destinationRoot: string;
  selectedUntrackedPaths: string[];
  packageName?: string;
}

export interface RehearseCommand {
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
