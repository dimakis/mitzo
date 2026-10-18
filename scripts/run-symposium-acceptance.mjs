import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const required = args.includes('--required');
const owners = args.includes('--owners');
const artifacts = args.includes('--artifacts');
const evidenceIndex = args.indexOf('--evidence-dir');
const directory = evidenceIndex === -1 ? undefined : args[evidenceIndex + 1];
const allowed = new Set([
  '--required',
  '--owners',
  '--artifacts',
  '--evidence-dir',
  ...(directory ? [directory] : []),
]);
if (args.some((arg) => !allowed.has(arg)) || (evidenceIndex !== -1 && !directory)) {
  throw Error(
    'Usage: node scripts/run-symposium-acceptance.mjs [--required] [--owners] [--artifacts] [--evidence-dir PATH]',
  );
}
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Capture before writing evidence, including every untracked harness source.
const untracked = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter(Boolean)
  .filter((file) => /\.(ts|tsx|mjs|json)$/.test(file) && !file.startsWith('docs/evidence/'));
const source = {
  commit: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  status: git('status', '--porcelain'),
  trackedDiffSha256: sha256(git('diff', 'HEAD', '--', '.', ':!docs/evidence')),
  untrackedSourceSha256: Object.fromEntries(
    untracked.map((file) => [file, sha256(readFileSync(join(root, file)))]),
  ),
};
const argv = [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--config',
  'vitest.symposium-acceptance.config.ts',
];
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, argv, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=1024',
    SYMPOSIUM_REQUIRED_JOURNEYS: required ? '1' : '0',
    SYMPOSIUM_OWNER_CONTRACTS: owners ? '1' : '0',
    SYMPOSIUM_ARTIFACT_CANDIDATE: artifacts ? '1' : '0',
  },
});
let output = '';
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    output += chunk.toString();
  });
child.on('error', (error) => {
  throw error;
});
child.on('close', (code, signal) => {
  const result = {
    source,
    startedAt,
    finishedAt: new Date().toISOString(),
    command: ['node', ...argv],
    requiredJourneys: required,
    reusedOwnerContracts: owners,
    artifactCandidate: artifacts,
    heapMiB: 1024,
    maxWorkers: 1,
    node: process.version,
    vitest: JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8'))
      .version,
    exitCode: code,
    signal,
    result: code === 0 ? 'passed_scoped_checks' : 'failed',
    outputSha256: sha256(output),
    liveQualification: 'not performed; this runner selects offline fixtures only',
  };
  if (directory) {
    const target = resolve(root, directory);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'output.log'), output);
    writeFileSync(join(target, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  process.exitCode = code ?? 1;
});
