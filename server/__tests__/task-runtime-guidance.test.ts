import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  TASK_CAPABILITY_PROBE,
  taskRuntimeGuidance,
  meetingPrepGuidance,
} from '../task-runtime-guidance.js';

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('checks the task root rather than a published knowledge root without running entrypoints', () => {
  root = mkdtempSync(join(tmpdir(), 'task-capabilities-'));
  mkdirSync(join(root, 'command_center'));
  writeFileSync(join(root, 'mgmt'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(root, 'mgmt'), 0o755);
  writeFileSync(
    join(root, 'command_center/meeting_prep.py'),
    '#!/usr/bin/python3\nraise Exception("must not run")\n',
  );
  const probe = () =>
    JSON.parse(
      execFileSync('/bin/sh', ['-c', TASK_CAPABILITY_PROBE, 'probe', root!], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      }),
    );
  expect(probe()).toEqual({ mgmtCli: true, meetingPrep: false, gws: false });
  chmodSync(join(root, 'command_center/meeting_prep.py'), 0o755);
  expect(probe()).toEqual({ mgmtCli: true, meetingPrep: true, gws: false });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/gws'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  expect(
    JSON.parse(
      execFileSync('/bin/sh', ['-c', TASK_CAPABILITY_PROBE, 'probe', root], {
        env: { PATH: join(root, 'bin') },
        encoding: 'utf8',
      }),
    ),
  ).toEqual({ mgmtCli: true, meetingPrep: true, gws: true });
  unlinkSync(join(root, 'mgmt'));
  symlinkSync(join(root, 'bin/gws'), join(root, 'mgmt'));
  expect(probe().mgmtCli).toBe(false);
});

it('reports missing and unknown capabilities without sending the agent to debug them', () => {
  const missing = taskRuntimeGuidance({ mgmtCli: false, meetingPrep: false, gws: true });
  expect(missing).toContain('./mgmt: unavailable');
  expect(missing).toContain('./command_center/meeting_prep.py: unavailable');
  expect(missing).toContain('gws: entrypoint present');
  expect(missing).toContain('does not prove dependencies, credentials or network access');
  expect(missing).toContain('After one classified failure');
  expect(taskRuntimeGuidance()).toContain('inventory unavailable');
});

it('routes meeting preparation through the invite and bounded current evidence', () => {
  expect(meetingPrepGuidance).toContain('calendar event first');
  expect(meetingPrepGuidance).toContain('linked documents');
  expect(meetingPrepGuidance).toContain('relevant Jira');
  expect(meetingPrepGuidance).toContain('targeted historical');
  expect(meetingPrepGuidance).toContain('partial brief');
});
