import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const artifacts = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (!source || !isAbsolute(source)) throw Error('Explicit public source checkout required');
const proof = JSON.parse(readFileSync(join(artifacts, 'source-qualification.json'), 'utf8'));
const workspace = mkdtempSync(join(tmpdir(), 'routing-public-source-proof-'));
const directory = join(workspace, 'source');
const home = join(workspace, 'home');
const temporary = join(workspace, 'tmp');
for (const path of [directory, home, temporary]) mkdirSync(path, { mode: 0o700 });
const env = {
  HOME: home,
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  TMPDIR: temporary,
};
let phase = 'start';
function git(args, input) {
  phase = args[0];
  return execFileSync('/usr/bin/git', args, {
    cwd: directory,
    env,
    input,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 67108864,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
try {
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--no-tags', '--depth', '1', resolve(source), proof.upstreamCommit]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  git(['apply', join(artifacts, 'native.patch')]);
  git(['add', '--all']);
  const observedTree = git(['write-tree']);
  if (observedTree !== proof.sourceTree) throw Error('Final source tree mismatch');
  git(['apply', '--reverse', join(artifacts, 'native-style.patch')]);
  git(['add', '--all']);
  if (git(['write-tree']) !== proof.nativeParentTree) throw Error('Parent source tree mismatch');
  if (
    git(
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      readFileSync(join(artifacts, 'native-parent-commit.txt')),
    ) !== proof.nativeParentCommit
  )
    throw Error('Parent source commit mismatch');
  git(['apply', join(artifacts, 'native-style.patch')]);
  git(['add', '--all']);
  if (git(['write-tree']) !== proof.sourceTree) throw Error('Restored source tree mismatch');
  if (
    git(
      ['hash-object', '-t', 'commit', '-w', '--stdin'],
      readFileSync(join(artifacts, 'native-commit.txt')),
    ) !== proof.nativeCommit
  )
    throw Error('Final source commit mismatch');
  git(['checkout', '--quiet', '--detach', proof.nativeCommit]);
  if (git(['rev-list', '--count', 'HEAD']) !== '3')
    throw Error('Source history qualification mismatch');
  const archive = execFileSync('/usr/bin/git', ['archive', 'HEAD'], {
    cwd: directory,
    env,
    timeout: 15000,
    maxBuffer: 67108864,
  });
  if (createHash('sha256').update(archive).digest('hex') !== proof.sourceArchiveSha256)
    throw Error('Source archive mismatch');
  console.log(
    JSON.stringify({
      sourceTree: proof.sourceTree,
      nativeCommit: proof.nativeCommit,
      sourceArchiveSha256: proof.sourceArchiveSha256,
      reachableCommitCount: 3,
      modelCalls: 0,
      qualified: true,
    }),
  );
} catch {
  console.log(JSON.stringify({ qualified: false, phase, modelCalls: 0 }));
  process.exitCode = 1;
}
