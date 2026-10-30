import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

type Step = { id?: string; run?: string; if?: string };
type Job = { needs?: string | string[]; if?: string; steps: Step[] };
const { jobs } = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, Job>;
};
function enabled(condition: string | undefined, needs: unknown, cancelled = false, success = true) {
  const expression = condition?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? 'success()';
  return new Script(expression).runInNewContext({
    needs,
    cancelled: () => cancelled,
    success: () => success,
  });
}
it('admits expensive owners only after complete preflight, retaining conditional selection', () => {
  for (const name of [
    'prepared-consumers',
    'core',
    'unit',
    'browser',
    'offline',
    'native',
    'ordinary-journey',
    'ordinary-joined',
    'ordinary-supplemental',
  ]) {
    const job = jobs[name];
    expect([job.needs].flat(), name).toContain('preflight');
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      expect(
        enabled(job.if, {
          preflight: { result },
          'frontend-build': { result: 'success' },
          changes: {
            result: 'success',
            outputs: { browser: 'true', native: 'true', prepared: 'true', ordinary: 'true' },
          },
        }),
        name,
      ).toBe(false);
    }
    const needs = {
      preflight: { result: 'success' },
      'frontend-build': { result: 'success' },
      changes: {
        result: 'success',
        outputs: { browser: 'true', native: 'true', prepared: 'true', ordinary: 'true' },
      },
    };
    expect(enabled(job.if, needs), name).toBe(true);
    expect(enabled(job.if, needs, true), name).toBe(false);
    needs.changes.outputs = {
      browser: 'false',
      native: 'false',
      prepared: 'false',
      ordinary: 'false',
    };
    expect(enabled(job.if, needs), name).toBe(
      ![
        'browser',
        'offline',
        'native',
        'prepared-consumers',
        'ordinary-journey',
        'ordinary-joined',
        'ordinary-supplemental',
      ].includes(name),
    );
  }
});
it('exposes every independent compiler and source-pin failure before rejecting the candidate', () => {
  const steps = jobs.preflight?.steps.filter((step) => step.id?.startsWith('preflight-')) ?? [];
  expect(steps.map((step) => step.run)).toEqual([
    'npm run build:server',
    'npx tsc --noEmit',
    'cd frontend && npx tsc -b',
    'npm run check:source-artifacts',
  ]);
  // Execute the actual workflow commands against controlled compiler/package tools.
  // The command fixture records each independent failure without compiling this host.
  const root = mkdtempSync(join(tmpdir(), 'ci-compile-preflight-'));
  const log = join(root, 'checks.log');
  try {
    mkdirSync(join(root, 'frontend'));
    for (const tool of ['npm', 'npx']) {
      const file = join(root, tool);
      writeFileSync(
        file,
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.PREFLIGHT_LOG, JSON.stringify({tool:${JSON.stringify(tool)},args:process.argv.slice(2),cwd:process.cwd()})+'\\n');
console.error('controlled compile/source failure');
process.exit(7);
`,
      );
      chmodSync(file, 0o755);
    }
    const exits: number[] = [];
    for (const step of steps) {
      expect(enabled(step.if, {}, false, false)).toBe(true);
      expect(enabled(step.if, {}, true, false)).toBe(false);
      if (
        enabled(
          step.if,
          {},
          false,
          exits.every((exit) => exit === 0),
        )
      ) {
        const result = spawnSync('/bin/sh', ['-c', step.run!], {
          cwd: root,
          env: { ...process.env, PATH: root + ':' + process.env.PATH, PREFLIGHT_LOG: log },
          encoding: 'utf8',
        });
        expect(result.stderr).toContain('controlled compile/source failure');
        exits.push(result.status!);
      }
    }
    expect(exits).toEqual([7, 7, 7, 7]);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => [call.tool, ...call.args])).toEqual([
      ['npm', 'run', 'build:server'],
      ['npx', 'tsc', '--noEmit'],
      ['npx', 'tsc', '-b'],
      ['npm', 'run', 'check:source-artifacts'],
    ]);
    expect(calls[2].cwd).toBe(realpathSync(join(root, 'frontend')));
    expect(exits.every((exit) => exit === 0)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('admits Mac and interaction checks as soon as preflight succeeds, with Linux waiting for both producers', () => {
  const early = [
    'prepared-consumers',
    'browser',
    'native',
    'ordinary-journey',
    'ordinary-joined',
    'ordinary-supplemental',
  ];
  const linux = ['core', 'unit', 'offline'];
  for (const result of ['failure', 'cancelled', 'skipped', '', 'success']) {
    const needs = {
      preflight: { result: 'success' },
      'frontend-build': { result },
      changes: {
        result: 'success',
        outputs: { browser: 'true', native: 'true', prepared: 'true', ordinary: 'true' },
      },
    };
    for (const name of early) {
      expect([jobs[name].needs].flat(), name).not.toContain('frontend-build');
      expect(enabled(jobs[name].if, needs), name).toBe(true);
    }
    for (const name of linux) {
      expect([jobs[name].needs].flat(), name).toContain('frontend-build');
      expect(enabled(jobs[name].if, needs), name).toBe(result === 'success');
    }
  }
});
