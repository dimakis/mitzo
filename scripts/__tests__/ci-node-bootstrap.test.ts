import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { expect, it } from 'vitest';

it('installs pinned npm without a writable system prefix and uses it for dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-node-bootstrap-'));
  try {
    const bin = join(root, 'bootstrap-bin');
    const job = join(root, 'job temp');
    const githubPath = join(root, 'github-path');
    const proof = join(root, 'dependency-proof');
    mkdirSync(bin);
    mkdirSync(job);
    writeFileSync(githubPath, '');
    const installer = join(bin, 'npm');
    const pinnedNpm = [
      '#!/bin/sh',
      'set -eu',
      '[ "$*" = "install --no-audit" ]',
      'printf pinned-npm > "$CI_NPM_PROOF"',
      '',
    ].join('\n');
    writeFileSync(
      installer,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs'), path = require('node:path');",
        'const args = process.argv.slice(2);',
        "const prefix = args[args.indexOf('--prefix') + 1];",
        "if (!args.includes('--global') || !args.includes('--prefix') || !prefix.startsWith(process.env.RUNNER_TEMP + path.sep)) throw Error('EACCES: system npm prefix is read-only');",
        "if (!args.includes('npm@11.18.0')) throw Error('Unexpected npm version');",
        "fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });",
        "fs.writeFileSync(path.join(prefix, 'bin/npm'), " +
          JSON.stringify(pinnedNpm) +
          ', { mode: 0o755 });',
      ].join('\n'),
    );
    chmodSync(installer, 0o755);
    const action = load(readFileSync('.github/actions/ci-node/action.yml', 'utf8')) as {
      runs: { steps: Array<{ run?: string }> };
    };
    for (const step of action.runs.steps.filter((step) => step.run)) {
      const addedPaths = readFileSync(githubPath, 'utf8').trim().split('\n').filter(Boolean);
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run!], {
        env: {
          PATH: [...addedPaths, bin, process.env.PATH].join(':'),
          RUNNER_TEMP: job,
          GITHUB_PATH: githubPath,
          CI_NPM_PROOF: proof,
        },
        stdio: 'pipe',
      });
    }
    expect(readFileSync(proof, 'utf8')).toBe('pinned-npm');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
