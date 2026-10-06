// Installed as bin/staging.mjs only during the reviewed initial transition.
import process from 'node:process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = join(userInfo().homedir, '.local/share/mitzo-staging');
const fd = openSync(join(root, 'service/topology.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
let mode;
try {
  const s = fstatSync(fd);
  if (
    !s.isFile() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o600 ||
    s.nlink !== 1 ||
    s.size > 8192
  )
    throw Error('Private canonical topology required');
  mode = JSON.parse(readFileSync(fd, 'utf8'));
} finally {
  closeSync(fd);
}
if (
  mode.mode !== 'owned-custodian' ||
  !/^[a-f0-9]{40}$/.test(mode.sourceCommit) ||
  !['check', 'drain'].includes(process.argv[2])
)
  throw Error('Canonical owned topology permits only original-owner check/drain');
const controller = join(
  root,
  'releases',
  mode.sourceCommit.slice(0, 12),
  'scripts/symposium-staging.mjs',
);
const result = spawnSync(process.execPath, [controller, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: userInfo().homedir },
});
process.exitCode = result.status ?? 1;
