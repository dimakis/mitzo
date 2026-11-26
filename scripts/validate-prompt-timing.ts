/** Real HTTP/backend offline E2E. Never starts Mitzo or a native/model process. */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, release, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  promptTimingSummary,
  type summarizePromptTiming,
} from '../server/__tests__/fixtures/prompt-trace-timing.js';
import type {
  startPhaseAResources,
  summarizePhaseA,
} from '../server/__tests__/fixtures/phase-a-measurement.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
if (
  args.some((value, index) => index % 2 === 0 && !['--runs', '--output'].includes(value)) ||
  args.length % 2
)
  throw Error(
    'Usage: node --import tsx scripts/validate-prompt-timing.ts [--runs 3] [--output report.json]',
  );
const runs = Number(option('--runs', '3'));
if (!Number.isInteger(runs) || runs < 1 || runs > 10)
  throw Error('Runs must be an integer from 1 to 10');
const output = resolve(option('--output', 'prompt-timing.json'));
const privateRoot = await mkdtemp(join(tmpdir(), 'mitzo-prompt-timing-'));
type Run = ReturnType<typeof summarizePromptTiming> & {
  runtime: string;
  clock: string;
  fixture: Record<string, unknown>;
  phaseA: ReturnType<typeof summarizePhaseA>;
  resources: ReturnType<ReturnType<typeof startPhaseAResources>['stop']>;
};
const sourceFiles = [
  'package-lock.json',
  'scripts/validate-prompt-timing.ts',
  'server/__tests__/prompt-trace-timing.e2e.test.ts',
  'server/__tests__/fixtures/owned-ordinary-workspace-runtime.ts',
  'server/__tests__/fixtures/prompt-trace-timing.ts',
  'server/__tests__/fixtures/phase-a-measurement.ts',
  'server/ordinary-local-codex-entry.ts',
  'server/codex-conversation.ts',
  'server/codex-app-server-client.ts',
  'server/local-codex-observation.ts',
];
async function sourceSnapshot() {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(join(root, file)))
            .digest('hex'),
        ]),
      ),
    ),
  };
}
const results: Run[] = [];
const validationStarted = process.hrtime.bigint();
try {
  const source = await sourceSnapshot();
  for (let index = 0; index < runs; index++) {
    const home = join(privateRoot, 'run-' + index);
    await mkdir(home, { mode: 0o700 });
    const file = join(home, 'timing.json');
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(MITZO_|OTEL_|LOKI_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|CODEX_|SRT_|CONTEXTGIN_)/.test(key)
      )
        delete env[key];
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      CI: 'true',
      TZ: 'UTC',
      NODE_OPTIONS: '--max-old-space-size=1024',
      MITZO_PROMPT_TIMING_OUTPUT: file,
      ...(process.env.MITZO_PROMPT_DISPATCH_BUDGET_MS === undefined
        ? {}
        : { MITZO_PROMPT_DISPATCH_BUDGET_MS: process.env.MITZO_PROMPT_DISPATCH_BUDGET_MS }),
    });
    delete env.SSH_AUTH_SOCK;
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        'server/__tests__/prompt-trace-timing.e2e.test.ts',
        '--maxWorkers=1',
        '--hookTimeout=30000',
      ],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (result.status !== 0 || result.error) {
      // Only failures expose the ordinary test diagnostic; never export raw spans/logs.
      process.stderr.write(result.stdout + result.stderr);
      throw Error('Offline prompt timing run failed: ' + (index + 1));
    }
    results.push(JSON.parse(await readFile(file, 'utf8')) as Run);
  }
  if (JSON.stringify(await sourceSnapshot()) !== JSON.stringify(source))
    throw Error('Source changed during measurement; no baseline published');
  const samples = results.flatMap((result, run) =>
    result.samples.map((sample) => ({ ...sample, run: run + 1 })),
  );
  const report = {
    version: 2,
    recordedAt: new Date().toISOString(),
    elapsedMs: Number(process.hrtime.bigint() - validationStarted) / 1e6,
    sourceHead: source.head,
    sourceDirty: source.dirty,
    sourceFiles: source.files,
    runtime: process.version,
    environment: {
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpuModel: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      nodeAbi: process.versions.modules,
      workers: 1,
      heapLimitMiB: 1024,
      timezone: 'UTC',
      ci: true,
    },
    coverage: {
      modelCalls: 0,
      measuredRoutes: ['local Codex / synthetic personal subscription / fixture-model'],
      unmeasuredRoutes: ['Claude', 'Codex API accounts', 'OpenShell', 'Gemini'],
      load: 'one retained session; four commands per run; one deliberately queued follow-up',
      productionLoad: false,
      capacityClaim: false,
      telemetry: 'in-memory OTel collector only; no production exporter/query coverage claim',
    },
    boundary: results[0].boundary,
    clock: results[0].clock,
    fixture: results[0].fixture,
    runs,
    units: 'milliseconds',
    summary: promptTimingSummary(samples),
    measurements: results.map((result, run) => ({
      run: run + 1,
      ...result.phaseA,
      resources: result.resources,
    })),
    samples,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('Server receipt → controlled stream write completion (ms)');
  console.table(report.summary);
  console.log('Sanitized trace timing artifact: ' + output);
} finally {
  await rm(privateRoot, { recursive: true, force: true });
}
