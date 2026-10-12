import { expect, it, vi } from 'vitest';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshVmInput } from './fixtures/staging-fresh-applehv-plan.js';
import { createFreshAppleHvPlan } from '../../scripts/lib/staging-fresh-applehv.mjs';
import {
  superviseFreshAppleHvVm,
  parseFreshAppleHvSupervisorArguments,
} from '../../scripts/start-staging-allocation-vm.mjs';

it('supervisor arguments cannot carry a command, guard override or restart grant', () => {
  expect(
    parseFreshAppleHvSupervisorArguments([
      '--plan',
      '/stage/plan.json',
      '--guard',
      '/private/tmp/guard.sock',
    ]),
  ).toEqual({ planPath: '/stage/plan.json', guardPath: '/private/tmp/guard.sock' });
  for (const args of [
    ['--plan', '/stage/plan.json', '--apply'],
    ['--command', 'podman start'],
    ['--plan', 'relative', '--guard', '/private/tmp/sock'],
  ])
    expect(() => parseFreshAppleHvSupervisorArguments(args)).toThrow();
});
function fixture() {
  const approved = createFreshAppleHvPlan(freshVmInput()),
    calls = [];
  const supervisor = {
      pid: 42,
      birth: 'supervisor',
      command: approved.plan.supervisor.programArguments.join(' '),
    },
    podman = { pid: 45, birth: 'podman' };
  const vfkit = {
      pid: 43,
      parentPid: 45,
      birth: 'vfkit',
      command: approved.plan.helpers[1].path + ' original devices',
    },
    gvproxy = {
      pid: 44,
      parentPid: 45,
      birth: 'gvproxy',
      command: approved.plan.helpers[2].path + ' original network',
    };
  const request = vi.fn(async (message) => {
    calls.push(message.kind);
    return message.kind === 'authorize'
      ? { kind: 'authorized', planSha256: approved.sha256 }
      : message.kind === 'current'
        ? { kind: 'current' }
        : { kind: 'recorded' };
  });
  const effects = {
    verifyInputs: vi.fn(async () => {}),
    currentSupervisor: vi.fn(() => supervisor),
    startPodman: vi.fn(async () => {
      calls.push('podman');
      return { podman, vfkit, gvproxy, startedAt: Date.parse('2026-10-12T12:00:00Z') };
    }),
  };
  return { approved, calls, request, effects };
}
it('no native start happens without original live controller acknowledgement', async () => {
  const f = fixture();
  f.request.mockRejectedValue(Error('original controller gone'));
  await expect(superviseFreshAppleHvVm(f.approved, f.request, f.effects)).rejects.toThrow();
  expect(f.effects.startPodman).not.toHaveBeenCalled();
});
it('exact guard acknowledgement precedes one stock start and original-lineage report', async () => {
  const f = fixture();
  const result = await superviseFreshAppleHvVm(f.approved, f.request, f.effects);
  expect(f.calls).toEqual(['authorize', 'current', 'podman', 'running']);
  expect(result.supervisor.pid).toBe(42);
  expect(f.effects.startPodman).toHaveBeenCalledTimes(1);
});
it('a mismatched acknowledgement cannot select the native helper', async () => {
  const f = fixture();
  f.request.mockResolvedValue({ kind: 'authorized', planSha256: '0'.repeat(64) });
  await expect(superviseFreshAppleHvVm(f.approved, f.request, f.effects)).rejects.toThrow();
  expect(f.effects.startPodman).not.toHaveBeenCalled();
});
it('actual supervisor CLI cannot reopen a saved plan without its original private live guard', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fresh-vm-orphan-')));
  try {
    const input = freshVmInput(root, randomUUID());
    input.node.path = input.supervisor.programArguments[0] = process.execPath;
    const approved = createFreshAppleHvPlan(input),
      path = input.supervisor.programArguments[3];
    mkdirSync(join(input.nativeRoot, 'service'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(approved.plan), { mode: 0o600 });
    const r = spawnSync(
      process.execPath,
      [
        'scripts/start-staging-allocation-vm.mjs',
        '--plan',
        path,
        '--guard',
        approved.plan.qualification.guardSocket,
      ],
      { encoding: 'utf8', timeout: 5000, env: { NODE_OPTIONS: '--max-old-space-size=1024' } },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('supervisor refused or uncertain');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
