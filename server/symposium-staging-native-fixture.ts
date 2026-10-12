import type { SymposiumNativeProfileTools } from './symposium-native-profile-tools.js';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import Database from 'better-sqlite3';
import { chmodSync, lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { EventStore } from './event-store.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
import type { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import {
  assertSessionArtifactVolume,
  type SessionArtifactMapping,
  type SymposiumSessionArtifacts,
} from './symposium-session-artifacts.js';
import {
  assertSymposiumRuntimeForStagingFeature,
  type createSymposiumSessionRuntime,
} from './symposium-session-runtime.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';

export const STAGING_NATIVE_FIXTURE_WRITER = String.raw`
import os, sys
root, nonce = sys.argv[1:]
if len(nonce) != 64 or any(c not in '0123456789abcdef' for c in nonce):
    raise RuntimeError('invalid fixture nonce')
if sorted(os.listdir(root)) != ['.git']:
    raise RuntimeError('fresh artifact fixture required')
fd = os.open(root + '/nonce.txt', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
with os.fdopen(fd, 'w') as stream:
    stream.write(nonce + '\n')
    stream.flush()
    os.fsync(stream.fileno())
print('MITZO_STAGING_FIXTURE_V1')
`;
export const STAGING_NATIVE_FIXTURE_READER = String.raw`
import hashlib, os, stat, sys
root, expected = sys.argv[1:]
fd = os.open(root + '/nonce.txt', os.O_RDONLY | os.O_NOFOLLOW)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != 65 or stat.S_IMODE(info.st_mode) != 0o400:
        raise RuntimeError('immutable bounded fixture required')
    value = os.read(fd, 66)
    if len(value) != 65 or value[-1:] != b'\n' or hashlib.sha256(value[:-1]).hexdigest() != expected:
        raise RuntimeError('fixture identity changed')
    sys.stdout.write(value.decode('ascii'))
finally:
    os.close(fd)
`;

export const STAGING_NATIVE_FIXTURE_REVISION = createHash('sha256')
  .update(STAGING_NATIVE_FIXTURE_WRITER + STAGING_NATIVE_FIXTURE_READER)
  .digest('hex');
type Runtime = ReturnType<typeof createSymposiumSessionRuntime>;
export interface StagingNativeFixture {
  readonly sessionId: string;
  readonly volumeName: string;
  readonly volumeGeneration: string;
  readonly fixturePath: string;
  readonly nonceSha256: string;
}
/** Owned child helper and artifact lifecycle, fixed to one retained native host.
 * The journal retains uncertain identities. It never reconstructs capabilities.
 * Only source code inside that host receives this object; HTTP has no constructor. */
export class SymposiumStagingNativeFixtures {
  private readonly db: Database.Database;
  private readonly retained = new Map<
    StagingNativeFixture,
    {
      runtime?: Runtime;
      retired?: object;
      readIssued?: boolean;
      readStarted?: boolean;
      readReceipt?: object;
    }
  >();
  private preparing = false;
  constructor(
    private readonly deps: {
      path: string;
      gateway: OwnedSymposiumGateway;
      owner: SymposiumArtifactOwner;
      artifacts: SymposiumSessionArtifacts;
      leases: SqliteArtifactLeaseHost;
      attempts: SymposiumAttemptRegistry;
      events: EventStore;
      assertOriginalOwnerCurrent(): void;
    },
  ) {
    deps.assertOriginalOwnerCurrent();
    deps.gateway.verifyCustody();
    if ((statSync(dirname(deps.path)).mode & 0o077) !== 0)
      throw Error('Private original fixture ledger required');
    try {
      const file = lstatSync(deps.path);
      if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077)
        throw Error('Private original fixture ledger required');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new Database(deps.path);
    chmodSync(deps.path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS staging_native_fixtures (
      session_id TEXT PRIMARY KEY, mapping_json TEXT NOT NULL, nonce_sha256 TEXT NOT NULL,
      helper_name TEXT NOT NULL, helper_id TEXT, helper_removed INTEGER NOT NULL DEFAULT 0,
      volume_removed INTEGER NOT NULL DEFAULT 0,
      read_helper_name TEXT, read_helper_id TEXT, read_helper_removed INTEGER NOT NULL DEFAULT 0
    )`);
    const columns = this.db.pragma('table_info(staging_native_fixtures)') as Array<{
      name: string;
    }>;
    for (const [name, definition] of [
      ['read_helper_name', 'TEXT'],
      ['read_helper_id', 'TEXT'],
      ['read_helper_removed', 'INTEGER NOT NULL DEFAULT 0'],
    ])
      if (!columns.some((column) => column.name === name))
        this.db.exec(`ALTER TABLE staging_native_fixtures ADD COLUMN ${name} ${definition}`);
  }
  private current(assertRunCurrent: () => void) {
    this.deps.assertOriginalOwnerCurrent();
    this.deps.gateway.verifyCustody();
    assertRunCurrent();
  }
  async prepare(
    sessionId: string,
    nonce: string,
    assertRunCurrent: () => void,
  ): Promise<StagingNativeFixture> {
    this.current(assertRunCurrent);
    if (
      this.preparing ||
      [...this.retained.values()].some((value) => !value.retired) ||
      this.db
        .prepare('SELECT 1 FROM staging_native_fixtures WHERE volume_removed=0 LIMIT 1')
        .get() ||
      (this.db.prepare('SELECT count(*) AS n FROM staging_native_fixtures').get() as { n: number })
        .n >= 100
    )
      throw Error('Original native fixture requires reconciliation');
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw Error('Bounded native fixture nonce required');
    const session = this.deps.events.getSession(sessionId);
    const config = session?.symposiumConfig ? JSON.parse(session.symposiumConfig) : null;
    if (
      session?.sessionType !== 'symposium' ||
      config?.state !== 'draft' ||
      this.deps.attempts.hasSessionClaims(sessionId) ||
      this.deps.events.getSymposiumMembershipHistory(sessionId).length ||
      this.deps.events.getSymposiumDeliveries(sessionId).length
    )
      throw Error('Pristine original staging draft required');
    const mapping = this.deps.artifacts.getReady(sessionId);
    if (!mapping) throw Error('Original ready native artifact mapping required');
    await this.inspect(mapping, assertRunCurrent);
    const helperName = `${mapping.volumeName}-stage-fixture`;
    const fixture = Object.freeze({
      ...mapping,
      fixturePath: `${SYMPOSIUM_ARTIFACT_TARGET}/nonce.txt`,
      nonceSha256: createHash('sha256').update(nonce).digest('hex'),
    });
    this.db
      .prepare(
        'INSERT INTO staging_native_fixtures (session_id,mapping_json,nonce_sha256,helper_name) VALUES (?,?,?,?)',
      )
      .run(sessionId, JSON.stringify(mapping), fixture.nonceSha256, helperName);
    this.preparing = true;
    try {
      const command = this.deps.leases.snapshotCommand();
      this.current(assertRunCurrent);
      const helperId = (
        await command(
          [
            'create',
            '--pull=never',
            '--name',
            helperName,
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=8',
            '--memory=32m',
            '--cpus=1',
            '--timeout=20',
            '--user',
            `${this.deps.owner.uid}:${this.deps.owner.gid}`,
            '--mount',
            `type=volume,src=${mapping.volumeName},dst=${SYMPOSIUM_ARTIFACT_TARGET}`,
            '--entrypoint=/usr/bin/python3',
            this.deps.owner.image,
            '-I',
            '-B',
            '-S',
            '-c',
            STAGING_NATIVE_FIXTURE_WRITER,
            SYMPOSIUM_ARTIFACT_TARGET,
            nonce,
          ],
          512,
          undefined,
          20000,
        )
      ).trim();
      if (!/^[a-f0-9]{64}$/.test(helperId))
        throw Error('Original fixture helper identity unavailable');
      // Persist the actual terminal identity before any further fence can fail.
      this.db
        .prepare('UPDATE staging_native_fixtures SET helper_id=? WHERE session_id=?')
        .run(helperId, sessionId);
      this.current(assertRunCurrent);
      const output = await command(['start', '--attach', helperId], 512, undefined, 20000);
      if (output.trim() !== 'MITZO_STAGING_FIXTURE_V1')
        throw Error('Original fixture writer is unconfirmed');
      this.current(assertRunCurrent);
      const removed = await command(['rm', helperId], 512, undefined, 20000);
      if (removed.trim() !== helperId)
        throw Error('Original fixture helper removal is unconfirmed');
      this.current(assertRunCurrent);
      this.db
        .prepare('UPDATE staging_native_fixtures SET helper_removed=1 WHERE session_id=?')
        .run(sessionId);
      await this.inspect(mapping, assertRunCurrent);
      this.retained.set(fixture, {});
      return fixture;
    } finally {
      this.preparing = false;
    }
  }
  private async inspect(mapping: SessionArtifactMapping, assertRunCurrent: () => void) {
    this.current(assertRunCurrent);
    const current = this.deps.artifacts.getReady(mapping.sessionId);
    if (
      !current ||
      current.sessionId !== mapping.sessionId ||
      current.volumeName !== mapping.volumeName ||
      current.volumeGeneration !== mapping.volumeGeneration
    )
      throw Error('Original fixture mapping changed');
    assertSessionArtifactVolume(
      this.deps.gateway.workspace,
      mapping,
      await this.deps.leases.inspectVolume(mapping.volumeName, 'podman'),
    );
    this.current(assertRunCurrent);
  }
  bindRuntime(fixture: StagingNativeFixture, runtime: Runtime): void {
    this.deps.assertOriginalOwnerCurrent();
    const retained = this.retained.get(fixture);
    if (!retained || retained.runtime || retained.retired)
      throw Error('Original native fixture capability unavailable');
    assertSymposiumRuntimeForStagingFeature(
      runtime,
      this.deps.events,
      this.deps.leases,
      this.deps.attempts,
      fixture.sessionId,
    );
    retained.runtime = runtime;
  }
  /** The actual native Codex dynamic-tool bridge calls this fixed Read. It
   * reads the original physical volume, never a local nonce copy or result flag. */
  readTools(
    fixture: StagingNativeFixture,
    execution: SymposiumSeatExecution,
    verifyNativeToolCurrent: () => void,
  ): SymposiumNativeProfileTools {
    const retained = this.retained.get(fixture);
    if (
      !retained?.runtime ||
      retained.readIssued ||
      retained.retired ||
      execution.sessionId !== fixture.sessionId ||
      execution.seat.id !== 'primary'
    )
      throw Error('Original native fixture Read capability unavailable');
    assertSymposiumRuntimeForStagingFeature(
      retained.runtime,
      this.deps.events,
      this.deps.leases,
      this.deps.attempts,
      fixture.sessionId,
    );
    retained.readIssued = true;
    return {
      tools: [
        {
          name: 'Read',
          description: 'Read this immutable staging nonce fixture exactly once.',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string', enum: [fixture.fixturePath] } },
            required: ['file_path'],
            additionalProperties: false,
          },
        },
      ],
      instructions:
        'Use Read exactly once on the requested fixture. Other tools and delegation are unavailable.',
      executeTool: async (name, args, signal) => {
        if (
          name !== 'Read' ||
          !args ||
          Array.isArray(args) ||
          Object.keys(args).join() !== 'file_path' ||
          args.file_path !== fixture.fixturePath ||
          retained.readStarted ||
          retained.retired
        )
          throw Error('Exact original nonce Read required');
        const current = () => {
          signal.throwIfAborted();
          execution.signal.throwIfAborted();
          this.current(verifyNativeToolCurrent);
          assertSymposiumRuntimeForStagingFeature(
            retained.runtime!,
            this.deps.events,
            this.deps.leases,
            this.deps.attempts,
            fixture.sessionId,
            execution.claimToken,
          );
        };
        current();
        retained.readStarted = true;
        const helperName = `${fixture.volumeName}-stage-read`;
        this.db
          .prepare('UPDATE staging_native_fixtures SET read_helper_name=? WHERE session_id=?')
          .run(helperName, fixture.sessionId);
        await this.inspect(fixture, current);
        const command = this.deps.leases.snapshotCommand();
        const helperId = (
          await command(
            [
              'create',
              '--pull=never',
              '--name',
              helperName,
              '--network=none',
              '--read-only',
              '--cap-drop=ALL',
              '--security-opt=no-new-privileges',
              '--pids-limit=8',
              '--memory=32m',
              '--cpus=1',
              '--timeout=20',
              '--user',
              `${this.deps.owner.uid}:${this.deps.owner.gid}`,
              '--mount',
              `type=volume,src=${fixture.volumeName},dst=${SYMPOSIUM_ARTIFACT_TARGET},ro=true`,
              '--entrypoint=/usr/bin/python3',
              this.deps.owner.image,
              '-I',
              '-B',
              '-S',
              '-c',
              STAGING_NATIVE_FIXTURE_READER,
              SYMPOSIUM_ARTIFACT_TARGET,
              fixture.nonceSha256,
            ],
            512,
            undefined,
            20000,
          )
        ).trim();
        if (!/^[a-f0-9]{64}$/.test(helperId))
          throw Error('Original Read helper identity unavailable');
        this.db
          .prepare('UPDATE staging_native_fixtures SET read_helper_id=? WHERE session_id=?')
          .run(helperId, fixture.sessionId);
        current();
        const content = await command(['start', '--attach', helperId], 128, undefined, 20000);
        if (
          !/^[a-f0-9]{64}\n$/.test(content) ||
          createHash('sha256').update(content.slice(0, -1)).digest('hex') !== fixture.nonceSha256
        )
          throw Error('Original Read helper content is unconfirmed');
        current();
        if ((await command(['rm', helperId], 512, undefined, 20000)).trim() !== helperId)
          throw Error('Original Read helper removal is unconfirmed');
        current();
        this.db
          .prepare('UPDATE staging_native_fixtures SET read_helper_removed=1 WHERE session_id=?')
          .run(fixture.sessionId);
        current();
        retained.readReceipt = Object.freeze({
          claimToken: execution.claimToken,
          contentSha256: createHash('sha256').update(content).digest('hex'),
          helperIdSha256: createHash('sha256').update(helperId).digest('hex'),
          confirmedAt: Date.now(),
        });
        return { content, isError: false };
      },
    };
  }

  async retire(fixture: StagingNativeFixture, claimToken: string, assertRunCurrent: () => void) {
    this.current(assertRunCurrent);
    const retained = this.retained.get(fixture);
    if (!retained?.runtime || retained.retired || (retained.readIssued && !retained.readReceipt))
      throw Error('Original fixture retirement capability unavailable');
    assertSymposiumRuntimeForStagingFeature(
      retained.runtime,
      this.deps.events,
      this.deps.leases,
      this.deps.attempts,
      fixture.sessionId,
      claimToken,
    );
    const process = this.deps.attempts.readOriginalStopReceipt(claimToken);
    const observation = this.deps.attempts.observations.get(claimToken);
    if (
      !observation ||
      observation.identity.sessionId !== fixture.sessionId ||
      process.sessionId !== fixture.sessionId
    )
      throw Error('Original native fixture claim differs');
    const sandbox = retained.runtime.owner.readOriginalRetirement(
      observation.identity.seatId,
      observation.identity.membershipGeneration,
    );
    if (
      !sandbox.artifactLeaseReleased ||
      sandbox.sandboxName !== process.sandboxName ||
      this.deps.attempts.pending().some((row) => row.sessionId === fixture.sessionId) ||
      this.deps.leases.sealLeaseIdentities('podman', fixture.volumeName).length
    )
      throw Error('Original native fixture physical retirement is incomplete');
    await this.inspect(fixture, assertRunCurrent);
    const command = this.deps.leases.snapshotCommand();
    this.current(assertRunCurrent);
    const removed = await command(['volume', 'rm', fixture.volumeName], 512, undefined, 20000);
    if (removed.trim() !== fixture.volumeName)
      throw Error('Original native fixture volume removal unconfirmed');
    this.current(assertRunCurrent);
    const listed = JSON.parse(
      await command(
        ['volume', 'ls', '--filter', `name=^${fixture.volumeName}$`, '--format', 'json'],
        512,
      ),
    );
    if (!Array.isArray(listed) || listed.length !== 0)
      throw Error('Original native fixture volume remains or was replaced');
    this.current(assertRunCurrent);
    this.db
      .prepare('UPDATE staging_native_fixtures SET volume_removed=1 WHERE session_id=?')
      .run(fixture.sessionId);
    const receipt = Object.freeze({
      version: 1,
      sessionId: fixture.sessionId,
      volumeGeneration: fixture.volumeGeneration,
      fixtureRevision: STAGING_NATIVE_FIXTURE_REVISION,
      processReceiptSha256: createHash('sha256').update(JSON.stringify(process)).digest('hex'),
      sandboxReceiptSha256: createHash('sha256').update(JSON.stringify(sandbox)).digest('hex'),
      ...(retained.readReceipt
        ? {
            readReceiptSha256: createHash('sha256')
              .update(JSON.stringify(retained.readReceipt))
              .digest('hex'),
          }
        : {}),
      confirmedAt: Date.now(),
    });
    retained.retired = receipt;
    return receipt;
  }
  /** The retained original journal records only positively completed cleanup.
   * This is a shutdown prerequisite, never a reopened runtime capability or a
   * physical stop receipt. It needs no new work or resource admission. */
  assertOriginalDrained(): void {
    if (
      !this.db.open ||
      this.preparing ||
      [...this.retained.values()].some((value) => !value.retired) ||
      this.db
        .prepare(
          `SELECT 1 FROM staging_native_fixtures
           WHERE volume_removed=0 OR helper_removed=0
           OR (read_helper_name IS NOT NULL AND read_helper_removed=0) LIMIT 1`,
        )
        .get()
    )
      throw Error('Original native fixture retirement is incomplete');
  }
  close() {
    this.retained.clear();
    this.db.close();
  }
}
