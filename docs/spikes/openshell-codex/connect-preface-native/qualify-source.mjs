import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const artifacts = dirname(fileURLToPath(import.meta.url));
const previous = resolve(artifacts, '../routing-diagnostic-native');
const source = process.argv[2];
if (!source || !isAbsolute(source)) throw Error('Explicit public source checkout required');
const proof = JSON.parse(readFileSync(join(artifacts, 'source-qualification.json'), 'utf8'));
const parent = JSON.parse(readFileSync(join(previous, 'source-qualification.json'), 'utf8'));
const workspace = mkdtempSync(join(tmpdir(), 'connect-preface-public-source-proof-'));
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
function tree(expected) {
  git(['add', '--all']);
  if (git(['write-tree']) !== expected) throw Error('Exact public tree mismatch');
}
function commit(path, expected) {
  if (git(['hash-object', '-t', 'commit', '-w', '--stdin'], readFileSync(path)) !== expected)
    throw Error('Exact public commit mismatch');
}
try {
  if (
    proof.nativeParentCommit !== parent.nativeCommit ||
    proof.upstreamCommit !== parent.upstreamCommit
  )
    throw Error('Recorded public predecessor mismatch');
  git(['init', '--quiet']);
  git(['fetch', '--quiet', '--no-tags', '--depth', '1', resolve(source), parent.upstreamCommit]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  git(['apply', join(previous, 'native.patch')]);
  tree(parent.sourceTree);
  git(['apply', '--reverse', join(previous, 'native-style.patch')]);
  tree(parent.nativeParentTree);
  commit(join(previous, 'native-parent-commit.txt'), parent.nativeParentCommit);
  git(['apply', join(previous, 'native-style.patch')]);
  tree(parent.sourceTree);
  commit(join(previous, 'native-commit.txt'), parent.nativeCommit);
  git(['checkout', '--quiet', '--detach', parent.nativeCommit]);
  git(['apply', join(artifacts, 'native.patch')]);
  tree(proof.sourceTree);
  commit(join(artifacts, 'native-commit.txt'), proof.nativeCommit);
  git(['checkout', '--quiet', '--detach', proof.nativeCommit]);
  if (git(['rev-list', '--count', 'HEAD']) !== '4') throw Error('Exact source history mismatch');
  const archive = execFileSync('/usr/bin/git', ['archive', 'HEAD'], {
    cwd: directory,
    env,
    timeout: 15000,
    maxBuffer: 67108864,
  });
  if (createHash('sha256').update(archive).digest('hex') !== proof.sourceArchiveSha256)
    throw Error('Exact source archive mismatch');
  console.log(
    JSON.stringify({
      sourceTree: proof.sourceTree,
      nativeCommit: proof.nativeCommit,
      sourceArchiveSha256: proof.sourceArchiveSha256,
      reachableCommitCount: 4,
      modelCalls: 0,
      qualified: true,
    }),
  );
} catch {
  console.log(JSON.stringify({ qualified: false, phase, modelCalls: 0 }));
  process.exitCode = 1;
}
