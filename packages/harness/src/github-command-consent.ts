/** Deliberately small command grammar, not a shell interpreter. Unsupported
 * syntax retains ordinary command approval. Never authorize a shell prefix. */
function argumentsOf(command: string): string[] | undefined {
  if (/[\r\n\0$`]/.test(command)) return;
  const args: string[] = [];
  let rest = command.trim();
  while (rest) {
    const match = /^(?:"([^"\\]*)"|'([^'\\]*)'|([A-Za-z0-9_./:@=,+%-]+))(?:[ \t]+|$)/.exec(rest);
    if (!match) return;
    args.push(match[1] ?? match[2] ?? match[3]!);
    rest = rest.slice(match[0].length);
  }
  return args;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function repositoryName(value: string): string | undefined {
  if (!repositoryPattern.test(value) || value.split('/').some((p) => p === '.' || p === '..'))
    return;
  return value.toLowerCase();
}

/** CI inspection and GET-only API reads with an explicit repository. No writes,
 * downloads, output files, headers, alternate hosts, aliases or shell chaining. */
export function githubReadCommandRepository(command: string): string | undefined {
  const args = argumentsOf(command);
  if (!args || args.shift() !== 'gh') return;
  const family = args.shift();
  const action = family === 'run' ? args.shift() : undefined;
  if (family !== 'api' && !(family === 'run' && (action === 'view' || action === 'list'))) return;
  let repository: string | undefined;
  let positional = false;
  const seen = new Set<string>();
  const booleanFlags =
    family === 'api' ? ['--paginate', '--slurp'] : ['--log', '--log-failed', '--exit-status'];
  const valueFlags =
    family === 'api'
      ? { '--method': 'method', '-X': 'method', '--jq': 'jq', '-q': 'jq' }
      : {
          '--repo': 'repo',
          '-R': 'repo',
          '--job': 'job',
          '-j': 'job',
          '--attempt': 'attempt',
          '-a': 'attempt',
          '--json': 'json',
          '--jq': 'jq',
          '-q': 'jq',
          '--limit': 'limit',
          '-L': 'limit',
          '--workflow': 'workflow',
          '-w': 'workflow',
          '--branch': 'branch',
          '-b': 'branch',
          '--status': 'status',
          '-s': 'status',
          '--event': 'event',
          '-e': 'event',
          '--user': 'user',
          '-u': 'user',
        };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (booleanFlags.includes(arg)) {
      if (seen.has(arg)) return;
      seen.add(arg);
      continue;
    }
    if (arg.startsWith('-')) {
      const [flag, ...inline] = arg.split('=');
      const key = (valueFlags as Record<string, string>)[flag!];
      if (!key || seen.has(key)) return;
      seen.add(key);
      const value = inline.length ? inline.join('=') : args[++i];
      if (!value || value.startsWith('-')) return;
      if (key === 'method' && value !== 'GET') return;
      if (key === 'repo') {
        repository = repositoryName(value);
        if (!repository) return;
      }
      if (['job', 'attempt', 'limit'].includes(key) && !/^\d+$/.test(value)) return;
      continue;
    }
    if (positional) return;
    positional = true;
    if (family === 'api') {
      const path = arg.split('?')[0]!;
      if (path.includes('%') || path.split('/').some((p) => p === '.' || p === '..')) return;
      const match = /^\/?repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(path);
      repository = match ? repositoryName(match[1]!) : undefined;
      if (!repository) return;
    } else if (action !== 'view' || !/^\d+$/.test(arg)) return;
  }
  return repository;
}

export function githubCommandConsentDescription(repository: string): string {
  return `Allow for session covers GitHub CLI repository reads and CI logs for ${repository} in this directory. Writes, downloads, other repositories and changed access still require approval.`;
}
