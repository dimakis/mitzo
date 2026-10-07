import process from 'node:process';
import console from 'node:console';
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';
import { assertPinnedStageSource } from './control-lib/staging-operations.mjs';
import {
  artifacts,
  fingerprintDirectory,
  assertVisibleTrackedIndex,
} from './control-lib/staging-files.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (root !== join(homedir(), '.local/share/mitzo-staging') || realpathSync(root) !== root)
  throw Error('Staging root refused');
if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check'))
  throw Error('Staging arguments refused');
function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > 262144
    )
      throw Error('Private staging input refused');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
const receipt = privateJson(join(root, 'service/release-receipt.json'));
const release = receipt.release;
if (
  !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
  release !== join(root, 'releases', receipt.sourceCommit.slice(0, 12)) ||
  receipt.port !== 3190 ||
  receipt.bind !== '127.0.0.1' ||
  receipt.workspace !== join(root, 'workspace')
)
  throw Error('Staging boundaries changed');
function git(args, allowFailure = false) {
  const result = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd: release,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        HOME: join(root, 'home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
      encoding: 'utf8',
    },
  );
  if (allowFailure) return result.status === 0;
  if (result.status !== 0) throw Error('Pinned staging Git identity unavailable');
  return result.stdout.trim();
}
if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== release)
  throw Error('Pinned Git worktree differs from release');
assertVisibleTrackedIndex(git(['ls-files', '-v']));
assertPinnedStageSource({
  expected: receipt.sourceCommit,
  expectedTree: receipt.sourceTree,
  source: git(['rev-parse', 'HEAD']),
  tree: git(['rev-parse', 'HEAD^{tree}']),
  dirty: git(['status', '--porcelain', '--untracked-files=no']),
  origin: git(['remote', 'get-url', 'origin']),
  acceptedAncestor: git(
    ['merge-base', '--is-ancestor', receipt.sourceCommit, 'refs/remotes/origin/main'],
    true,
  ),
});
const expectedArtifacts = receipt.compiledArtifacts;
if (
  !expectedArtifacts ||
  typeof expectedArtifacts !== 'object' ||
  Array.isArray(expectedArtifacts) ||
  !Object.keys(expectedArtifacts).length
)
  throw Error('Staging compiled artifact inventory missing');
const canonicalMap = (value) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
if (canonicalMap(artifacts(release)) !== canonicalMap(expectedArtifacts))
  throw Error('Staging compiled artifact inventory changed');

const resolved = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '--eval',
    "import {fileURLToPath} from 'node:url';console.log(JSON.stringify(['@mitzo/protocol','@mitzo/harness','@mitzo/client'].map(name=>fileURLToPath(import.meta.resolve(name)))))",
  ],
  {
    cwd: release,
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: join(root, 'home') },
    encoding: 'utf8',
  },
);
if (resolved.status !== 0) throw Error('Staging package resolution refused');
for (const path of JSON.parse(resolved.stdout))
  if (!realpathSync(path).startsWith(release + '/')) throw Error('Staging package escaped release');
if (
  !receipt.dependencyFingerprint ||
  fingerprintDirectory(release, 'node_modules') !== receipt.dependencyFingerprint
)
  throw Error('Staging dependency drift');
const settings = privateJson(join(root, 'settings/operator.json'));
if (
  Object.keys(settings).sort().join(',') !== 'AUTH_PASSPHRASE,AUTH_SECRET' ||
  typeof settings.AUTH_PASSPHRASE !== 'string' ||
  settings.AUTH_PASSPHRASE.length < 32 ||
  typeof settings.AUTH_SECRET !== 'string' ||
  settings.AUTH_SECRET.length < 64
)
  throw Error('Staging authentication refused');
if (JSON.stringify(privateJson(join(root, 'settings/account-profiles.json'))) !== '[]')
  throw Error('Provider setup requires an independently reviewed staging configuration update');
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: join(root, 'home'),
  TMPDIR: '/private/tmp',
  LANG: 'en_US.UTF-8',
  NODE_ENV: 'development',
  DOTENV_CONFIG_PATH: '/dev/null',
  PORT: '3190',
  MITZO_BIND_HOST: '127.0.0.1',
  REPO_PATH: join(root, 'workspace'),
  MITZO_REPO_PATH_CEILING: join(root, 'workspace'),
  MITZO_ACCOUNT_PROFILES_FILE: join(root, 'settings/account-profiles.json'),
  MITZO_CODEX_PRIVATE_DIR: join(root, 'state/codex'),
  XDG_CONFIG_HOME: join(root, 'state/config'),
  XDG_STATE_HOME: join(root, 'state'),
  XDG_CACHE_HOME: join(root, 'state/cache'),
  MITZO_DISABLE_REPO_MAINTENANCE: '1',
  MITZO_WORKTREE_CLEANUP_POLICY: 'none',
  MITZO_OPENSHELL_ENABLED: '0',
  MITZO_CODEX_ENABLED: '0',
  MITZO_CONNECTIONS_ENABLED: '0',
  CLAUDE_CODE_USE_VERTEX: '0',
  YAPPER_PROXY_TARGET: 'http://127.0.0.1:5191',
  CONTEXGIN_URL: 'http://127.0.0.1:5192',
  CENTAUR_URL: 'http://127.0.0.1:5193',
  MITZO_URL: 'http://127.0.0.1:3190',
  ...settings,
};
if (process.argv[2] === '--check') {
  console.log(
    JSON.stringify({
      label: receipt.label,
      source: receipt.sourceCommit,
      port: 3190,
      bind: '127.0.0.1',
      workspace: receipt.workspace,
      releaseGuard: 'passed',
      compiledArtifacts: Object.keys(receipt.compiledArtifacts).length,
      providerProfiles: 0,
      modelCalls: 0,
      productionPathsIncluded: false,
    }),
  );
} else {
  if (existsSync(join(root, 'service/deployment.lock'))) {
    const lock = privateJson(join(root, 'service/deployment.lock'));
    const permit = privateJson(join(root, 'service/launch-permit.json'));
    if (
      lock.id !== permit.id ||
      lock.target !== receipt.sourceCommit ||
      permit.target !== receipt.sourceCommit ||
      !Number.isFinite(permit.expiresAt) ||
      Date.now() > permit.expiresAt
    )
      throw Error('Uncertain or expired staging deployment; refuse restart');
    unlinkSync(join(root, 'service/launch-permit.json'));
  }
  process.chdir(release);
  process.execve(process.execPath, [process.execPath, join(release, 'dist/index.js')], env);
}
