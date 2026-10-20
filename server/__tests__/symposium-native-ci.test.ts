import { afterEach, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function runRecordedStep(exitCode: number, brokenLog = false, runnerOs = 'Linux') {
  const root = mkdtempSync(join(tmpdir(), 'symposium-native-ci-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'just'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > native-arguments\nprintf 'offline native fixture stdout\\n'\nprintf 'offline native fixture stderr\\n' >&2\nexit ${exitCode}\n`,
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, RUNNER_OS: runnerOs },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    result,
    log: brokenLog ? null : readFileSync(join(root, 'native-fixtures.log'), 'utf8'),
    arguments: readFileSync(join(root, 'native-arguments'), 'utf8').trim().split('\n'),
  };
}

it.each(['Linux', 'macOS'])(
  'executes all original crate fixtures and the affected Linux sandbox owner on %s',
  (runnerOs) => {
    const recorded = runRecordedStep(0, false, runnerOs);
    expect(recorded.result.status).toBe(0);
    expect(recorded.arguments).toEqual([
      'test',
      '-p',
      'codex-core',
      '-p',
      'codex-http-client',
      '-p',
      'codex-state',
      '-p',
      'codex-api',
      '-p',
      'codex-guardian-reviewer',
      '-p',
      'codex-extension-api',
      '-p',
      'codex-mcp-extension',
      '-p',
      'codex-login',
      '-p',
      'codex-memories-extension',
      '-p',
      'codex-web-search-extension',
      '-p',
      'codex-history-notes-extension',
      '-p',
      'codex-goal-extension',
      '-p',
      'codex-models-manager',
      '-p',
      'codex-home',
      '-p',
      'codex-model-provider-info',
      ...(runnerOs === 'Linux' ? ['-p', 'codex-linux-sandbox'] : []),
      '--test-threads',
      '1',
      '--retries',
      '0',
    ]);
  },
);

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

const v8StepName = 'Prepare verified Codex V8 artifacts';
function runRecordedV8(
  host: string,
  failVerification = false,
  overrides = false,
  sourceBuild = false,
) {
  const preparation = workflow.jobs.source.steps.find((entry) => entry.name === v8StepName);
  expect(preparation).toBeDefined();
  // Bash exposes the physical checkout path through PWD on macOS temporary symlinks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'symposium-native-v8-')));
  roots.push(root);
  const source = join(root, 'nested-native-source');
  const bin = join(root, 'bin');
  const modules = join(source, 'scripts/codex_package');
  mkdirSync(bin, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, '__init__.py'), '');
  writeFileSync(
    join(modules, 'targets.py'),
    'TARGET_SPECS = {h: h for h in ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]}\n',
  );
  writeFileSync(
    join(modules, 'v8.py'),
    `import json, os\nfrom pathlib import Path\nfrom types import SimpleNamespace\n\ndef resolved_v8_crate_version():\n    return "150.4.0"\n\ndef fetch_codex_v8_artifacts(spec, *, cache_root):\n    root = Path(os.environ["RUNNER_TEMP"])\n    (root / "fetch.json").write_text(json.dumps({"target": spec, "source": os.environ["CODEX_REPO_ROOT"], "cache": str(cache_root), "workspace": os.environ["GITHUB_WORKSPACE"]}))\n    if ${failVerification ? 'True' : 'False'}:\n        raise RuntimeError("recorded checksum verification failure")\n    cache_root.mkdir(parents=True, exist_ok=True)\n    archive, binding = cache_root / "archive.a.gz", cache_root / "binding.rs"\n    archive.write_bytes(b"verified archive")\n    binding.write_bytes(b"verified bindings")\n    return SimpleNamespace(archive=archive, binding=binding)\n`,
  );
  writeFileSync(join(bin, 'rustc'), `#!/bin/sh\nprintf 'rustc 1.95.0\\nhost: ${host}\\n'\n`, {
    mode: 0o700,
  });
  const script = join(root, 'prepare.sh');
  const exported = join(root, 'github-env');
  writeFileSync(script, preparation!.run!);
  writeFileSync(exported, '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
    cwd: source,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RUNNER_TEMP: root,
      GITHUB_ENV: exported,
      GITHUB_WORKSPACE: root,
      ...(overrides
        ? {
            RUSTY_V8_ARCHIVE: 'unverified-archive',
            RUSTY_V8_SRC_BINDING_PATH: 'unverified-bindings',
          }
        : {}),
      ...(sourceBuild ? { V8_FROM_SOURCE: '1' } : {}),
    },
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { root, source, result, exported: readFileSync(exported, 'utf8') };
}

it('prepares the source-pinned V8 archive and bindings before standalone helper compilation', () => {
  const steps = workflow.jobs.source.steps;
  const prepared = steps.findIndex((entry) => entry.name === v8StepName);
  expect(prepared).toBeGreaterThanOrEqual(0);
  expect(prepared).toBeLessThan(
    steps.findIndex((entry) => entry.name === 'Build standalone native test helpers'),
  );
  expect(steps[prepared].run).toContain('fetch_codex_v8_artifacts');
  expect(steps[prepared].run).not.toContain('resolve_codex_v8_cargo_env');
});
it.each(['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu'])(
  'executes actual preparation with the verified upstream pair for %s',
  (host) => {
    const run = runRecordedV8(host);
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(run.root, 'fetch.json'), 'utf8'))).toEqual({
      target: host,
      source: run.source,
      cache: join(run.root, 'native-rusty-v8'),
      workspace: run.root,
    });
    expect(run.exported).toBe(
      `RUSTY_V8_ARCHIVE=${join(run.root, 'native-rusty-v8/archive.a.gz')}\nRUSTY_V8_SRC_BINDING_PATH=${join(run.root, 'native-rusty-v8/binding.rs')}\n`,
    );
  },
);
it('refuses unsupported hosts before attempting artifact preparation', () => {
  const run = runRecordedV8('unsupported-target');
  expect(run.result.status).not.toBe(0);
  expect(run.result.stderr).toContain('Unsupported native CI host');
  expect(run.exported).toBe('');
});
it('exports neither V8 override when the pinned owner fails verification', () => {
  const run = runRecordedV8('aarch64-apple-darwin', true);
  expect(run.result.status).not.toBe(0);
  expect(run.result.stderr).toContain('recorded checksum verification failure');
  expect(run.exported).toBe('');
});
it('verifies both artifacts even when prior override paths exist', () => {
  const run = runRecordedV8('x86_64-unknown-linux-gnu', false, true);
  expect(run.result.status, run.result.stderr).toBe(0);
  expect(run.exported).not.toContain('unverified-');
  expect(run.exported).toContain('RUSTY_V8_ARCHIVE=');
  expect(run.exported).toContain('RUSTY_V8_SRC_BINDING_PATH=');
});
it('refuses an ambiguous compiler host before publishing overrides', () => {
  const run = runRecordedV8('aarch64-apple-darwin\nhost: x86_64-unknown-linux-gnu');
  expect(run.result.status).not.toBe(0);
  expect(run.result.stderr).toContain('Unsupported native CI host');
  expect(run.exported).toBe('');
});
it('refuses a source-build bypass of the verified archive and binding pair', () => {
  const run = runRecordedV8('aarch64-apple-darwin', false, false, true);
  expect(run.result.status).not.toBe(0);
  expect(run.result.stderr).toContain('V8 source-build override is unsupported');
  expect(run.exported).toBe('');
});

it('tests and formats the affected Guardian and extension registry owners on both native platforms', () => {
  for (const platform of ['Linux', 'macOS']) {
    const recorded = runRecordedStep(0, false, platform);
    expect(recorded.result.status).toBe(0);
    const selected = recorded.arguments.flatMap((value, index, args) =>
      value === '-p' ? [args[index + 1]] : [],
    );
    expect(selected).toEqual(
      expect.arrayContaining([
        'codex-guardian-reviewer',
        'codex-extension-api',
        'codex-mcp-extension',
        'codex-login',
        'codex-memories-extension',
        'codex-web-search-extension',
        'codex-models-manager',
      ]),
    );
  }
  const formatting = workflow.jobs.source.steps.find(
    (entry) => entry.name === 'Check native source formatting',
  );
  for (const crate of [
    'codex-guardian-reviewer',
    'codex-extension-api',
    'codex-mcp-extension',
    'codex-login',
    'codex-memories-extension',
    'codex-web-search-extension',
    'codex-models-manager',
    'codex-home',
    'codex-model-provider-info',
  ])
    expect(formatting?.run).toMatch(new RegExp(`(?:^|\\s)-p\\s+${crate}(?:\\s|$)`));
});
