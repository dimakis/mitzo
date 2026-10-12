import { describe, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const fs = await original();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
vi.mock('node:child_process', async (original) => {
  const child = await original();
  return { ...child, spawnSync: vi.fn(child.spawnSync) };
});
import { lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  parseNativeAppControlArguments,
  requestQualifiedNativeAppControl,
  assertNativeAppClientCompletion,
  selectNativeAppControlRow,
} from '../../scripts/lib/staging-native-app-control-client.mjs';

const allocation = '11111111-1111-1111-1111-111111111111';
const target = 'a'.repeat(40),
  current = 'b'.repeat(40),
  digest = 'c'.repeat(64);
const argv = (operation = 'resources', plan = 'none') => [
  '--allocation',
  allocation,
  '--operation',
  operation,
  '--target',
  target,
  '--expected-current',
  current,
  '--plan-sha256',
  plan,
];
const environment = { MITZO_STAGING_PIPELINE_TOKEN: '{"original":"queue-proof"}' };
describe('exact original native app control client', () => {
  it('publishes only the finite resources/plan/apply request and keeps proof off argv', () => {
    for (const operation of ['resources', 'plan', 'apply']) {
      const args = argv(operation, operation === 'apply' ? digest : 'none');
      const selected = parseNativeAppControlArguments(args, environment);
      expect(selected).toEqual({
        allocation,
        input: {
          version: 1,
          operation,
          target,
          expectedCurrent: current,
          planSha256: operation === 'apply' ? digest : null,
          queueProof: environment.MITZO_STAGING_PIPELINE_TOKEN,
        },
      });
      expect(args).not.toContain(environment.MITZO_STAGING_PIPELINE_TOKEN);
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.input)).toBe(true);
    }
  });
  it('refuses alternate roots, option reorder, duplicate flags, partial source IDs and unknown operations', () => {
    for (const args of [
      [...argv(), '--root', '/foreign'],
      argv().slice(2),
      [...argv(), '--target', target],
      ['--operation', 'resources', ...argv().slice(2)],
      argv().map((value) => (value === target ? target.slice(0, 12) : value)),
      argv('restart'),
      argv().map((value) => (value === allocation ? '../../foreign' : value)),
    ])
      expect(() => parseNativeAppControlArguments(args, environment)).toThrow();
  });
  it('requires the exact plan SHA only for apply, rejecting replay-shaped resource requests', () => {
    for (const args of [
      argv('apply'),
      argv('apply', digest.slice(0, 12)),
      argv('resources', digest),
      argv('plan', digest),
    ])
      expect(() => parseNativeAppControlArguments(args, environment)).toThrow();
  });
  it('refuses missing, empty and oversized private queue proof without borrowing another environment key', () => {
    for (const env of [
      {},
      { MITZO_STAGING_PIPELINE_TOKEN: '' },
      { MITZO_STAGING_PIPELINE_TOKEN: 'x'.repeat(2049) },
      { PRODUCTION_TOKEN: 'different-authority' },
    ])
      expect(() => parseNativeAppControlArguments(argv(), env)).toThrow();
  });
  it('refuses a task checkout before opening any staging record or observing a live process', async () => {
    vi.mocked(lstatSync).mockClear();
    vi.mocked(spawnSync).mockClear();
    await expect(
      requestQualifiedNativeAppControl(parseNativeAppControlArguments(argv(), environment)),
    ).rejects.toThrow();
    expect(lstatSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it('accepts a genuine successful app replacement only after authenticated response against the new physical owner', () => {
    const input = parseNativeAppControlArguments(argv('apply', digest), environment).input;
    const parent = { pid: 20, birth: 'original', cwd: '/original' };
    const original = {
      sourceCommit: current,
      instanceId: 'owner',
      epoch: 1,
      parent,
      app: { pid: 30 },
      acceptedAppSource: { acceptedAppCommit: current },
    };
    const owner = {
      ...original,
      epoch: 2,
      app: { pid: 40 },
      acceptedAppSource: { acceptedAppCommit: target },
    };
    const output = {
      version: 1,
      nativeSourceCommit: current,
      acceptedAppSource: owner.acceptedAppSource,
      planSha256: digest,
      nativeAllocationChanged: false,
      nativeRetirementClaim: false,
    };
    expect(() =>
      assertNativeAppClientCompletion(input, current, undefined, original, {
        phase: 'before-request',
      }),
    ).not.toThrow();
    expect(() =>
      assertNativeAppClientCompletion(input, current, original, owner, { phase: 'before-request' }),
    ).toThrow();
    expect(() =>
      assertNativeAppClientCompletion(input, current, original, owner, {
        phase: 'after-response',
        output,
      }),
    ).not.toThrow();
    for (const changed of [
      { owner: { ...owner, epoch: 1 } },
      { owner: { ...owner, app: { pid: 30 } } },
      { owner: { ...owner, instanceId: 'foreign' } },
      { owner: { ...owner, parent: { ...parent, pid: 21 } } },
      { output: { ...output, planSha256: 'd'.repeat(64) } },
      { output: { ...output, nativeRetirementClaim: true } },
      { output: { ...output, acceptedAppSource: { acceptedAppCommit: current } } },
    ])
      expect(() =>
        assertNativeAppClientCompletion(input, current, original, changed.owner ?? owner, {
          phase: 'after-response',
          output: changed.output ?? output,
        }),
      ).toThrow();
    expect(() =>
      assertNativeAppClientCompletion(
        { ...input, operation: 'resources' },
        current,
        original,
        owner,
        { phase: 'after-response', output },
      ),
    ).toThrow();
  });
  it('keeps the exact historical uncertain launch and selects only one new active launch', () => {
    const original = { launchId: 'old', state: 'retirement_uncertain', instanceId: 'original' };
    const facts = {
      original,
      operation: allocation,
      archiveRoot: '/archive',
      registryBackupSha256: 'd'.repeat(64),
      containmentReceiptSha256: 'e'.repeat(64),
    };
    const disposition = { facts, sha256: 'f'.repeat(64) };
    const history = {
      launchId: 'old',
      classification: 'contained_offline_native_cleanup_unconfirmed',
      recordJson: JSON.stringify({
        instanceId: 'original',
        launchId: 'old',
        state: 'retirement_uncertain',
      }),
      proposalSha256: disposition.sha256,
      operationId: allocation,
      archive: '/archive',
      registryBackupSha256: facts.registryBackupSha256,
      receiptSha256: facts.containmentReceiptSha256,
    };
    const active = { launchId: 'new', state: 'active' },
      rows = [original, active];
    expect(selectNativeAppControlRow(rows, history, disposition)).toBe(active);
    expect(original.state).toBe('retirement_uncertain');
    for (const changed of [
      { rows: [{ ...original, state: 'retired' }, active] },
      { rows: [original, active, { launchId: 'foreign', state: 'active' }] },
      { history: { ...history, operationId: 'foreign' } },
      { history: { ...history, recordJson: '{"launchId":"old"}' } },
      { history: { ...history, receiptSha256: '0'.repeat(64) } },
      { rows: [original] },
    ])
      expect(() =>
        selectNativeAppControlRow(changed.rows ?? rows, changed.history ?? history, disposition),
      ).toThrow();
  });
});
