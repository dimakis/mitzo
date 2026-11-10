import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the installed, checksum-qualified native runtime's actual child-env
// implementation. This never starts Claude, initializes accounts or uses network.
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const platform = `${process.platform}-${process.arch}`;
export const lockedClaudeExecutable = join(sdkRoot, '..', `claude-agent-sdk-${platform}`, 'claude');
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
const listStart = binary.indexOf('Gs1=[');
if (listStart < 0) throw Error('Locked Claude sensitive child-env list unavailable');
const listEnd = binary.indexOf(']', listStart);
const sensitive = JSON.parse(binary.toString('utf8', listStart + 4, listEnd + 1));
const source = ['CH', 'mK', 'c2', 'Ps1', 'pt_', 'VE'].map(actualFunction).join('\n');
export function lockedClaudeSubprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return runInNewContext(`${source}\nVE()`, {
    process: { env: { ...env } },
    Gs1: sensitive,
    ut_: undefined,
    Xg9: undefined,
    jg9: () => {
      throw Error('Unexpected remote branch in offline child-env qualification');
    },
  });
}
