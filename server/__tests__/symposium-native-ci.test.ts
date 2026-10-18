import { afterEach, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  with?: { path?: string };
};
const workflow = load(
  readFileSync(resolve(__dirname, '../../.github/workflows/prepared-request-native.yml'), 'utf8'),
) as { jobs: { source: { steps: Step[] } } };
const step = workflow.jobs.source.steps.find(
  (entry) => entry.name === 'Run native crate fixtures without provider credentials',
)!;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runRecordedStep(exitCode: number, brokenLog = false) {
  const root = mkdtempSync(join(tmpdir(), 'symposium-native-ci-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'just'),
    `#!/bin/sh\nprintf 'offline native fixture stdout\\n'\nprintf 'offline native fixture stderr\\n' >&2\nexit ${exitCode}\n`,
    { mode: 0o700 },
  );
  const script = join(root, 'step.sh');
  writeFileSync(script, step.run!);
  if (brokenLog) mkdirSync(join(root, 'native-fixtures.log'));
  // Match GitHub's documented unspecified versus explicit bash shell defaults.
  // Execute the actual retained run body; only the native test tool is recorded.
  const flags = step.shell === 'bash' ? ['--noprofile', '--norc', '-e', '-o', 'pipefail'] : ['-e'];
  const result = spawnSync('bash', [...flags, script], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    result,
    log: brokenLog ? null : readFileSync(join(root, 'native-fixtures.log'), 'utf8'),
  };
}

it('selects an explicit bash shell for the logged native test pipeline', () => {
  expect(step.shell).toBe('bash');
});
it('propagates a native test failure while retaining stdout and stderr in the actual log', () => {
  const { result, log } = runRecordedStep(37);
  expect(log).toBe('offline native fixture stdout\noffline native fixture stderr\n');
  expect(result.stdout).toContain('offline native fixture stdout');
  expect(result.status).toBe(37);
});
it('retains the same evidence for a successful native test command', () => {
  const { result, log } = runRecordedStep(0);
  expect(result.status).toBe(0);
  expect(log).toBe('offline native fixture stdout\noffline native fixture stderr\n');
});
it('refuses a failed evidence writer even if the native command succeeds', () => {
  expect(runRecordedStep(0, true).result.status).not.toBe(0);
});
it('uploads the exact native log even after a failed test step', () => {
  const retained = workflow.jobs.source.steps.find(
    (entry) => entry.name === 'Retain exact-source fixture evidence',
  )!;
  expect(retained.if).toBe('always()');
  expect(retained.with?.path).toContain('.native-prepared-source/codex-rs/native-fixtures.log');
});
it('builds and publishes the standalone helper paths required by actual Core fixtures', () => {
  const helper = workflow.jobs.source.steps.find(
    (entry) => entry.name === 'Build standalone native test helpers',
  );
  expect(helper).toBeDefined();
  expect(helper!.run).toContain('--locked --offline');
  for (const binary of [
    'codex',
    'test_stdio_server',
    'codex-code-mode-host',
    'codex-linux-sandbox',
    'test_streamable_http_server',
    'codex-execve-wrapper',
  ])
    expect(helper!.run).toContain(`--bin ${binary}`);
  for (const name of [
    'codex',
    'test_stdio_server',
    'codex_code_mode_host',
    'codex_linux_sandbox',
    'test_streamable_http_server',
    'codex_execve_wrapper',
  ])
    expect(helper!.run).toContain(`CARGO_BIN_EXE_${name}=`);
  expect(helper!.run).toContain('GITHUB_ENV');
});
it('supplies the pinned upstream Linux sandbox prerequisites without changing test guards', () => {
  const linux = workflow.jobs.source.steps.find(
    (entry) => entry.name === 'Prepare Linux native test prerequisites',
  );
  expect(linux).toBeDefined();
  expect(linux!.if).toContain("runner.os == 'Linux'");
  expect(linux!.run).toContain('bubblewrap');
  expect(linux!.run).toContain('kernel.unprivileged_userns_clone=1');
  expect(linux!.run).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  expect(step.run).not.toMatch(/(?:unset|env\s+-u)\s+CODEX_SANDBOX/);
});
it('installs the same immutable DotSlash action selected by pinned upstream CI', () => {
  expect(
    workflow.jobs.source.steps.some(
      (entry) =>
        entry.uses === 'facebook/install-dotslash@1e4e7b3e07eaca387acb98f1d4720e0bee8dbb6a',
    ),
  ).toBe(true);
});
