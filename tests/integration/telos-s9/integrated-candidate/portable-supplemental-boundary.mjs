import childProcess from 'node:child_process';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

export function selectSupplementalExecution(platform, portable) {
  if (!['darwin', 'linux'].includes(platform) || (portable !== undefined && portable !== '1'))
    throw Error('Select a supported supplemental execution owner');
  if (portable === '1') return 'portable-fixture-cli';
  if (platform !== 'darwin')
    throw Error('Linux supplemental journeys require an explicit portable fixture CLI');
  return 'native-macos';
}

function privateTemporaryPath(path) {
  if (!isAbsolute(path ?? '')) throw Error('Select an absolute private fixture path');
  const selected = realpathSync(path);
  const inside = relative(realpathSync(tmpdir()), selected);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
    throw Error('Supplemental CLI may use temporary fixture files only');
  return selected;
}

/** TEST ONLY: execute the retained real canonical CLI for application/UX claims.
 * The production protected-command runner still owns input/output, cancellation,
 * maxBuffer and timeout handling. This adapter supplies no OS isolation evidence;
 * canonical/joined macOS owners independently qualify the real native boundary.
 */
export function createPortableSupplementalBoundary({
  env = process.env,
  spawn = childProcess.spawn,
} = {}) {
  if (env.NODE_ENV !== 'test' || env.S9_SUPPLEMENTAL_PORTABLE_CLI !== '1')
    throw Error('Portable supplemental CLI is an explicitly selected test fixture only');
  const workspace = privateTemporaryPath(env.REPO_PATH);
  const script = privateTemporaryPath(join(workspace, 'command_center', 'todo_api.py'));
  const database = privateTemporaryPath(env.TELOS_DB_PATH);
  return {
    credentialIsolation: false,
    deniedRoots: [],
    spawnClaudeCodeProcess(options) {
      options.signal.throwIfAborted();
      if (
        options.command !== 'python3' ||
        options.args?.[0] !== script ||
        options.env?.NODE_ENV !== 'test' ||
        options.env?.S9_SUPPLEMENTAL_PORTABLE_CLI !== '1' ||
        options.env?.REPO_PATH !== workspace ||
        options.env?.TELOS_DB_PATH !== database
      )
        throw Error('Portable supplemental runner refuses a non-fixture canonical command');
      // Resolve the test paths at dispatch to reject retired fixtures or symbolic
      // redirection. This selection never represents a production grant.
      if (
        privateTemporaryPath(env.REPO_PATH) !== workspace ||
        privateTemporaryPath(script) !== script ||
        privateTemporaryPath(env.TELOS_DB_PATH) !== database
      )
        throw Error('Portable supplemental fixture changed before dispatch');
      return spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
  };
}
