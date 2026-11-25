import { readFileSync } from 'node:fs';
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

it.each(macosJobs)('%s uses the operator runner for same-repository PRs and main', (job) => {
  expect(
    runnerFor(job, {
      variable: 'true',
      eventName: 'pull_request',
      headRepository: 'dimakis/mitzo',
    }),
  ).toEqual(selfHosted);
  expect(runnerFor(job, { variable: 'true', eventName: 'push', ref: 'refs/heads/main' })).toEqual(
    selfHosted,
  );
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

it('never runs privileged fork-controlled events that could reach the operator runner', () => {
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
});
