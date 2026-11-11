import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the installed, checksum-qualified native runtime's actual child-env
// implementation. This never starts Claude, initializes accounts or uses network.
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
// Native bundles minify independently. Qualify each inspected platform against
// its own manifest checksum; never apply the macOS symbol names to Linux.
const qualifiedSymbols = {
  'darwin-arm64': {
    helpers: ['CH', 'mK', 'c2', 'Ps1', 'pt_'],
    truthy: 'CH',
    scrub: 'c2',
    cache: 'ut_',
    overrides: 'Xg9',
    remote: 'jg9',
    sensitive: 'Gs1',
    environment: 'VE',
    startup: 'lS8',
    control: 'X9O',
    merge: '$_H',
  },
  'linux-x64': {
    helpers: ['RH', 'm4', 'dW', '_s1', 'ut$'],
    truthy: 'RH',
    scrub: 'dW',
    cache: 'bt$',
    overrides: 'YgK',
    remote: 'qgK',
    sensitive: 'Ys1',
    environment: 'GI',
    startup: 'dS6',
    control: 'qKA',
    merge: 'A$H',
  },
};
export function qualifyLockedClaudeRuntime(platform = `${process.platform}-${process.arch}`) {
  const symbols = qualifiedSymbols[platform as keyof typeof qualifiedSymbols];
  if (!symbols) throw Error(`Requalify locked Claude child-env symbols for ${platform}`);
  const lockedClaudeExecutable = join(sdkRoot, '..', `claude-agent-sdk-${platform}`, 'claude');
  const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(sdkRoot, 'manifest.json'), 'utf8'));
  if (pkg.version !== '0.2.141') throw Error('Requalify the locked Claude child-env mechanism');
  const binary = readFileSync(lockedClaudeExecutable);
  if (createHash('sha256').update(binary).digest('hex') !== manifest.platforms[platform]?.checksum)
    throw Error('Locked Claude binary qualification failed');
  function actualFunction(name: string) {
    const start = binary.indexOf(`function ${name}(`);
    if (start < 0) throw Error(`Locked Claude child-env function unavailable: ${name}`);
    const end = binary.indexOf('function ', start + 9);
    if (end < start || end - start > 8192) throw Error('Locked Claude function boundary changed');
    return binary.toString('utf8', start, end);
  }
  const listPrefix = `${symbols.sensitive}=`;
  const listStart = binary.indexOf(`${listPrefix}[`);
  if (listStart < 0) throw Error('Locked Claude sensitive child-env list unavailable');
  const listEnd = binary.indexOf(']', listStart);
  const sensitive = JSON.parse(binary.toString('utf8', listStart + listPrefix.length, listEnd + 1));
  const source = [...symbols.helpers, symbols.environment].map(actualFunction).join('\n');
  function lockedClaudeSubprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return runInNewContext(`${source}\n${symbols.environment}()`, {
      process: { env: { ...env } },
      [symbols.sensitive]: sensitive,
      [symbols.cache]: undefined,
      [symbols.overrides]: undefined,
      [symbols.remote]: () => {
        throw Error('Unexpected remote branch in offline child-env qualification');
      },
    });
  }

  // Qualify the scrub flag's startup-mode override and the normal control API's
  // plan/default acknowledgement. The supplied merge only models unchanged
  // permission-context fields; the actual handler determines the accepted mode.
  function lockedClaudeStartupMode(env: NodeJS.ProcessEnv, mode: 'plan' | 'default') {
    return runInNewContext(
      `${[symbols.truthy, symbols.scrub, symbols.startup].map(actualFunction).join('\n')}\n${symbols.startup}({permissionModeCli: mode}).mode`,
      { process: { env, stderr: { write: () => {} } }, [symbols.cache]: undefined, mode },
    ) as string;
  }
  function lockedClaudeControlMode(mode: 'plan' | 'default', current: string) {
    const responses: unknown[] = [];
    const next = runInNewContext(
      `${actualFunction(symbols.control)}\n${symbols.control}({mode}, 'offline-mode', {mode: current}, transport)`,
      {
        mode,
        current,
        transport: { enqueue: (value: unknown) => responses.push(value) },
        [symbols.merge]: (_before: string, _after: string, context: object) => context,
      },
    );
    return { mode: next.mode as string, responses };
  }
  return {
    lockedClaudeExecutable,
    lockedClaudeSubprocessEnvironment,
    lockedClaudeStartupMode,
    lockedClaudeControlMode,
  };
}

export const {
  lockedClaudeExecutable,
  lockedClaudeSubprocessEnvironment,
  lockedClaudeStartupMode,
  lockedClaudeControlMode,
} = qualifyLockedClaudeRuntime();
