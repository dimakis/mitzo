import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source reconstruction only. Never builds/starts Codex or selects an account.
const artifacts = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
if (!source || !isAbsolute(source))
  throw new Error('Explicit pinned public source checkout required');
const proof = JSON.parse(readFileSync(join(artifacts, 'source-evidence.json'), 'utf8'));
const workspace = mkdtempSync(join(tmpdir(), 'symposium-prepared-source-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: workspace,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
try {
  git(['init', '--quiet']);
  git([
    '-c',
    'core.hooksPath=/dev/null',
    'fetch',
    '--quiet',
    '--no-tags',
    '--depth=1',
    source,
    proof.upstreamCommit,
  ]);
  git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (git(['rev-parse', 'HEAD^{tree}']) !== proof.upstreamTree)
    throw new Error('Upstream tree mismatch');
  for (const patch of proof.patches) {
    if (!/^[a-z-]+\.patch$/.test(patch.file)) throw new Error('Invalid patch name');
    const file = join(artifacts, patch.file);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== patch.sha256)
      throw new Error('Patch checksum mismatch');
    git(['apply', '--index', file]);
  }
  const tree = git(['write-tree']);
  if (tree !== proof.sourceTree) throw new Error('Prepared source tree mismatch');
  console.log(
    JSON.stringify({
      sourceReconstructed: true,
      sourceTree: tree,
      runtimeQualified: false,
      modelCalls: 0,
    }),
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
