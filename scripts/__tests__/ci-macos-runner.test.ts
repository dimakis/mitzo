import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

const source = readFileSync('.github/workflows/ci.yml', 'utf8');
const workflow = load(source) as {
  on: Record<string, unknown>;
  jobs: Record<string, { 'runs-on': string | string[] }>;
};
const macosJobs = ['native', 'ordinary-journey', 'ordinary-joined'];
const selfHosted = ['self-hosted', 'macOS', 'ARM64', 'mitzo-ci'];

type Context = {
  variable?: string;
  eventName: string;
  ref?: string;
  headRepository?: string | null;
};
/** Evaluate the runs-on expression with GitHub's null-tolerant property access. */
function runnerFor(job: string, context: Context) {
  const expression = String(workflow.jobs[job]['runs-on']).replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const github = {
    event_name: context.eventName,
    ref: context.ref ?? '',
    repository: 'dimakis/mitzo',
    event:
      context.eventName === 'pull_request'
        ? {
            pull_request: {
              head: { repo: context.headRepository ? { full_name: context.headRepository } : null },
            },
          }
        : {},
  };
  return new Script(expression.replace(/(\w)\.(\w)/g, '$1?.$2')).runInNewContext({
    github,
    vars: context.variable === undefined ? {} : { MITZO_MACOS_SELF_HOSTED: context.variable },
    fromJSON: JSON.parse,
  });
}

it('routes every macOS job through one shared guarded runner expression', () => {
  const expressions = macosJobs.map((job) => workflow.jobs[job]['runs-on']);
  expect(new Set(expressions).size).toBe(1);
  expect(String(expressions[0])).toContain(
    'github.event.pull_request.head.repo.full_name == github.repository',
  );
  for (const [name, job] of Object.entries(workflow.jobs))
    if (!macosJobs.includes(name))
      expect(JSON.stringify(job['runs-on'])).not.toMatch(/self-hosted|macos/i);
});

it.each(macosJobs)('%s keeps hosted macOS when the operator variable is unset', (job) => {
  for (const context of [
    { eventName: 'pull_request', headRepository: 'dimakis/mitzo' },
    { eventName: 'push', ref: 'refs/heads/main' },
  ])
    expect(runnerFor(job, context)).toBe('macos-26');
});

it.each(['false', '', '1', 'yes'])('ignores a non-true operator variable: %j', (variable) => {
  expect(
    runnerFor('native', { variable, eventName: 'pull_request', headRepository: 'dimakis/mitzo' }),
  ).toBe('macos-26');
});

it.each(macosJobs)('%s uses the operator runner only for same-repository PRs', (job) => {
  expect(
    runnerFor(job, {
      variable: 'true',
      eventName: 'pull_request',
      headRepository: 'dimakis/mitzo',
    }),
  ).toEqual(selfHosted);
});

it.each(macosJobs)('%s keeps post-merge main runs on clean hosted macOS when enabled', (job) => {
  expect(runnerFor(job, { variable: 'true', eventName: 'push', ref: 'refs/heads/main' })).toBe(
    'macos-26',
  );
  expect(String(workflow.jobs[job]['runs-on'])).not.toMatch(/push|refs\/heads\/main/);
});

it.each(macosJobs)('%s never sends a fork PR to the operator runner', (job) => {
  for (const headRepository of ['someone/mitzo', 'dimakis/mitzo-fork', 'DIMAKIS/mitzo-x', null])
    expect(runnerFor(job, { variable: 'true', eventName: 'pull_request', headRepository })).toBe(
      'macos-26',
    );
});

it('keeps other events and branches on hosted macOS even when enabled', () => {
  for (const context of [
    { variable: 'true', eventName: 'push', ref: 'refs/heads/feature' },
    { variable: 'true', eventName: 'push', ref: 'refs/tags/v1' },
    { variable: 'true', eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
    { variable: 'true', eventName: 'pull_request_target', headRepository: 'dimakis/mitzo' },
  ])
    expect(runnerFor('native', context)).toBe('macos-26');
});

const workflowSources = ['.github/workflows', '.github/actions']
  .flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name)),
  )
  .sort();

it('finds every workflow and composite action', () => {
  expect(workflowSources).toContain('.github/workflows/ci.yml');
  expect(workflowSources).toContain(join('.github/actions/ci-canonical-browser', 'action.yml'));
});

it.each(workflowSources)('%s never hardcodes the hosted runner home or tool cache', (file) => {
  const text = readFileSync(file, 'utf8');
  expect(text).not.toContain('/Users/' + 'runner');
  expect(text).not.toContain('/home/' + 'runner');
  expect(text).not.toContain('hostedtoolcache');
});

it('installs Python with setup-python only on GitHub-hosted runners', () => {
  const action = load(readFileSync('.github/actions/ci-canonical-browser/action.yml', 'utf8')) as {
    runs: { steps: Array<{ uses?: string; if?: string; run?: string }> };
  };
  const steps = action.runs.steps;
  const setup = steps.find((step) => step.uses?.startsWith('actions/setup-python@'));
  expect(setup?.if).toBe("runner.environment == 'github-hosted'");
  const venv = steps.find((step) => step.run?.includes('-m venv'))!.run!;
  expect(venv).toContain('command -v python3.13');
  expect(venv).toContain('sys.version_info[:2] == (3, 13)');
});

it('selects and verifies the Swift 6.3 Xcode per runner instead of a hosted-only job path', () => {
  const job = workflow.jobs.native as unknown as {
    env?: Record<string, string>;
    steps: Array<{ name?: string; run?: string }>;
  };
  expect(job.env?.DEVELOPER_DIR).toBeUndefined();
  const select = job.steps.find((step) => step.name === 'Select the Swift 6.3 Xcode toolchain');
  expect(select?.run).toContain('RUNNER_ENVIRONMENT');
  expect(select?.run).toContain('MITZO_CI_DEVELOPER_DIR');
  expect(select?.run).toContain('"DEVELOPER_DIR=$developer_dir" >> "$GITHUB_ENV"');
  const build = job.steps.findIndex(
    (step) => step.name === 'Build iPhone app with Watch companion',
  );
  expect(job.steps.indexOf(select!)).toBeLessThan(build);
});

it('never runs privileged fork-controlled events that could reach the operator runner', () => {
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
});
