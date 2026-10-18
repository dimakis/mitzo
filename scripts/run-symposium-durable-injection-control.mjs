import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--positive-evidence-dir' || args[2] !== '--evidence-dir') {
  throw Error(
    'Usage: node scripts/run-symposium-durable-injection-control.mjs --positive-evidence-dir PATH --evidence-dir NEW_PATH',
  );
}
const positiveDirectory = resolve(args[1]);
const output = resolve(args[3]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const positive = JSON.parse(readFileSync(resolve(positiveDirectory, 'result.json'), 'utf8'));
const raw = readFileSync(resolve(positiveDirectory, 'output.log'));
const log = stripVTControlCharacters(raw.toString('utf8'));
const failed = log.split('\n').filter((line) => line.trimStart().startsWith('FAIL '));
const joinName =
  'requires actual joining and finalized reply owners after the observational review';
if (
  !positive.requiredJourneys ||
  hash(raw) !== positive.outputSha256 ||
  /timed out|BLOCKED:|\bskipped\b/i.test(log) ||
  !(
    (positive.exitCode === 0 && failed.length === 0) ||
    (positive.exitCode === 1 && failed.length === 1 && failed[0].includes(joinName))
  )
) {
  throw Error(
    'No positive actual-app durable baseline: bootstrap/prerequisite failures cannot establish an omission control',
  );
}
if (
  positive.source.commit !== git('rev-parse', 'HEAD') ||
  positive.source.tree !== git('rev-parse', 'HEAD^{tree}') ||
  positive.source.trackedDiffSha256 !== hash('') ||
  git('diff', 'HEAD', '--', '.', ':!docs/evidence')
) {
  throw Error('Positive baseline must match this clean tracked source exactly');
}
const untracked = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter((file) => /\.(ts|tsx|mjs|json)$/.test(file) && !file.startsWith('docs/evidence/'));
const currentUntracked = Object.fromEntries(
  untracked.map((file) => [file, hash(readFileSync(resolve(root, file)))]),
);
if (JSON.stringify(currentUntracked) !== JSON.stringify(positive.source.untrackedSourceSha256)) {
  throw Error('Untracked source changed since the positive baseline');
}
const test = readFileSync(
  resolve(root, 'tests/acceptance/symposium-application-wiring.repro.ts'),
  'utf8',
);
const durableName =
  'reads exact completed durable source through actual production injection and typed client without restore or allocation';
if (
  !test.includes(`it('${durableName}'`) ||
  !test.includes('await expect(read()).resolves.toEqual(expected)')
) {
  throw Error('Actual-app durable positive assertion is absent');
}
if (existsSync(output)) throw Error('Control evidence directory must be new');
const app = resolve(root, 'server/app.ts');
const original = readFileSync(app);
const injection =
  '    getDurableSessionTranscript: (sessionId) => eventStore.getDurableSessionTranscript(sessionId),\n';
const source = original.toString('utf8');
if (source.split(injection).length !== 2)
  throw Error('Expected unique production durable-reader injection');
mkdirSync(output, { recursive: true });
let run;
try {
  // Omit only the real production injection; never install a success/fallback reader.
  writeFileSync(app, source.replace(injection, ''));
  run = spawnSync(
    process.execPath,
    ['scripts/run-symposium-acceptance.mjs', '--required', '--evidence-dir', output],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
    },
  );
} finally {
  writeFileSync(app, original);
}
if (!readFileSync(app).equals(original))
  throw Error('Production application bytes were not restored');
const negative = stripVTControlCharacters(readFileSync(resolve(output, 'output.log'), 'utf8'));
const failures = negative.split('\n').filter((line) => line.trimStart().startsWith('FAIL '));
const valid =
  run.status === 1 &&
  failures.some((line) => line.includes(durableName)) &&
  failures.every((line) => line.includes(durableName) || line.includes(joinName)) &&
  !/timed out|BLOCKED:/i.test(negative) &&
  negative.includes('resolves');
writeFileSync(
  resolve(output, 'control.json'),
  JSON.stringify(
    {
      control: 'Omitted only actual app durable-reader injection; no SDK/restore replacement',
      positiveEvidenceDirectory: positiveDirectory,
      positiveSource: positive.source,
      originalApplicationSha256: hash(original),
      restoredApplicationSha256: hash(readFileSync(app)),
      restoredByteForByte: true,
      validOmissionProof: valid,
      exitCode: run.status,
      signal: run.signal,
      scope: valid
        ? 'Positive durable source assertion fails after injection omission'
        : 'Unqualified control; do not count as accepted omission proof',
    },
    null,
    2,
  ) + '\n',
);
if (!valid)
  throw Error(
    'Omission did not isolate the positive durable assertion; raw run retained as unqualified',
  );
