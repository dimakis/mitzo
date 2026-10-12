import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SymposiumStagingNativeFixtures,
  STAGING_NATIVE_FIXTURE_WRITER,
  STAGING_NATIVE_FIXTURE_READER,
} from '../symposium-staging-native-fixture.js';
import { artifactVolumeLabels } from '../symposium-session-artifacts.js';
import type { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import type { OwnedSymposiumGateway } from '../symposium-owned-gateway.js';
import type { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import type { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import type { EventStore } from '../event-store.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-feature-fixture-'));
  roots.push(root);
  const mapping = {
    sessionId: 'stage-session',
    volumeName: 'mitzo-artifacts-test',
    volumeGeneration: 'generation',
  };
  const command = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'create' || args[0] === 'rm') return 'a'.repeat(64);
    if (args[0] === 'start') return 'MITZO_STAGING_FIXTURE_V1\n';
    throw Error('unexpected command');
  });
  const current = vi.fn();
  const deps = {
    path: join(root, 'fixtures.db'),
    owner: { image: 'pinned-image', uid: 998, gid: 998 },
    gateway: { workspace: 'stage', verifyCustody: vi.fn() } as unknown as OwnedSymposiumGateway,
    artifacts: { getReady: () => ({ ...mapping }) } as unknown as SymposiumSessionArtifacts,
    leases: {
      snapshotCommand: () => command,
      inspectVolume: async () => ({
        name: mapping.volumeName,
        driver: 'local',
        options: {},
        labels: artifactVolumeLabels('stage', mapping),
      }),
    } as unknown as SqliteArtifactLeaseHost,
    attempts: { hasSessionClaims: () => false } as unknown as SymposiumAttemptRegistry,
    events: {
      getSession: () => ({ sessionType: 'symposium', symposiumConfig: '{"state":"draft"}' }),
      getSymposiumMembershipHistory: () => [],
      getSymposiumDeliveries: () => [],
    } as unknown as EventStore,
    assertOriginalOwnerCurrent: current,
  };
  return { deps, command, current, mapping };
}
describe('original native fixture child lifecycle', () => {
  it('permits an unused original ledger to drain without any physical effects', () => {
    const f = fixture(),
      owner = new SymposiumStagingNativeFixtures(f.deps);
    expect(() => owner.assertOriginalDrained()).not.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    owner.close();
    expect(() => owner.assertOriginalDrained()).toThrow();
  });

  it('refuses a positive drain after writer failure, including a reopened journal', async () => {
    const f = fixture(),
      owner = new SymposiumStagingNativeFixtures(f.deps);
    f.command.mockRejectedValueOnce(Error('original helper creation uncertain'));
    await expect(owner.prepare(f.mapping.sessionId, 'b'.repeat(64), vi.fn())).rejects.toThrow(
      /uncertain/,
    );
    expect(() => owner.assertOriginalDrained()).toThrow(/retirement is incomplete/);
    expect(f.command).toHaveBeenCalledTimes(1);
    owner.close();
    const reopened = new SymposiumStagingNativeFixtures(f.deps);
    expect(() => reopened.assertOriginalDrained()).toThrow(/retirement is incomplete/);
    expect(f.command).toHaveBeenCalledTimes(1);
    reopened.close();
  });

  it('uses only the fixed isolated bounded writer, then positively removes the exact helper', async () => {
    const f = fixture(),
      owner = new SymposiumStagingNativeFixtures(f.deps),
      guard = vi.fn();
    const cap = await owner.prepare(f.mapping.sessionId, 'b'.repeat(64), guard);
    expect(cap.fixturePath).toBe('/sandbox/workspaces/mgmt/nonce.txt');
    expect(Object.isFrozen(cap)).toBe(true);
    expect(f.command).toHaveBeenCalledTimes(3);
    expect(() => owner.assertOriginalDrained()).toThrow(/retirement is incomplete/);
    expect(f.command.mock.calls[0][0]).toEqual([
      'create',
      '--pull=never',
      '--name',
      'mitzo-artifacts-test-stage-fixture',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=8',
      '--memory=32m',
      '--cpus=1',
      '--timeout=20',
      '--user',
      '998:998',
      '--mount',
      'type=volume,src=mitzo-artifacts-test,dst=/sandbox/workspaces/mgmt',
      '--entrypoint=/usr/bin/python3',
      'pinned-image',
      '-I',
      '-B',
      '-S',
      '-c',
      STAGING_NATIVE_FIXTURE_WRITER,
      '/sandbox/workspaces/mgmt',
      'b'.repeat(64),
    ]);
    expect(f.command.mock.calls.slice(1).map((call) => call[0])).toEqual([
      ['start', '--attach', 'a'.repeat(64)],
      ['rm', 'a'.repeat(64)],
    ]);
    await expect(owner.prepare('other', 'c'.repeat(64), guard)).rejects.toThrow(/reconciliation/);
    expect(() => owner.bindRuntime(cap, {} as never)).toThrow(/custody/);
    expect(() =>
      owner.readTools(cap, { sessionId: cap.sessionId, seat: { id: 'primary' } } as never, vi.fn()),
    ).toThrow(/Read capability/);
    expect(f.command).toHaveBeenCalledTimes(3);
    await expect(owner.retire({ ...cap }, 'claim', guard)).rejects.toThrow(/capability/);
    owner.close();
  });
  it.each(['create', 'start', 'rm'])(
    'retains uncertain %s child identity across reopen without adopting it',
    async (failed) => {
      const f = fixture();
      f.command.mockImplementation(async (args) => {
        if (args[0] === failed) return 'unconfirmed';
        return args[0] === 'start' ? 'MITZO_STAGING_FIXTURE_V1' : 'a'.repeat(64);
      });
      const owner = new SymposiumStagingNativeFixtures(f.deps);
      await expect(owner.prepare(f.mapping.sessionId, 'b'.repeat(64), vi.fn())).rejects.toThrow(
        /unconfirmed|unavailable/,
      );
      expect(
        f.command.mock.calls.some((call) => call[0][0] === 'rm' && call[0][1] === '--force'),
      ).toBe(false);
      owner.close();
      const reopened = new SymposiumStagingNativeFixtures(f.deps);
      await expect(reopened.prepare('other', 'b'.repeat(64), vi.fn())).rejects.toThrow(
        /reconciliation/,
      );
      reopened.close();
    },
  );
  it('fences after the actual helper creation response before starting it', async () => {
    const f = fixture(),
      owner = new SymposiumStagingNativeFixtures(f.deps);
    let allowed = true;
    f.command.mockImplementation(async () => {
      allowed = false;
      return 'a'.repeat(64);
    });
    await expect(
      owner.prepare(f.mapping.sessionId, 'b'.repeat(64), () => {
        if (!allowed) throw Error('original reservation lost');
      }),
    ).rejects.toThrow(/reservation lost/);
    expect(f.command).toHaveBeenCalledTimes(1);
    owner.close();
  });
});

describe('fixed physical native fixture reader', () => {
  it('reads only an immutable single-link bounded file with the exact fixture hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-fixture-reader-'));
    roots.push(root);
    const nonce = 'a'.repeat(64),
      path = join(root, 'nonce.txt');
    writeFileSync(path, nonce + '\n', { mode: 0o400 });
    const sha = createHash('sha256').update(nonce).digest('hex');
    const read = (expected = sha) =>
      execFileSync(
        '/usr/bin/python3',
        ['-I', '-B', '-S', '-c', STAGING_NATIVE_FIXTURE_READER, root, expected],
        { encoding: 'utf8', timeout: 1000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    expect(read()).toBe(nonce + '\n');
    expect(() => read('b'.repeat(64))).toThrow();
    chmodSync(path, 0o600);
    expect(() => read()).toThrow();
    chmodSync(path, 0o400);
    linkSync(path, join(root, 'other-link'));
    expect(() => read()).toThrow();
    rmSync(path);
    symlinkSync(join(root, 'other-link'), path);
    expect(() => read()).toThrow();
  });
});
