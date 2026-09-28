/** Credential-free real Podman initializer → mounted source API → source host → SQLite,
 * then production review composition → charged initial child admission and staged delivery.
 * App passphrase, configured local repository and custody are disposable test fixtures.
 * Direct native writer/reviewer probes make no model calls; production review admission
 * remains closed without trusted provider completion and an exact writer seal. */
import { expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ArtifactAdmissionBindingV1, SymposiumConfig } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';
import { SymposiumOrchestrator, type SymposiumSeatExecution } from '../symposium-orchestrator.js';
import { SymposiumNativeEventSink } from '../symposium-native-event-sink.js';
import { createSymposiumSuccessorFixAuthority } from '../symposium-artifact-successor-authority.js';
import { authMiddleware, login } from '../auth.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import { createSymposiumSourceHost } from '../symposium-source-service.js';
import { createSymposiumSourceRouter } from '../symposium-source-routes.js';
import { createArtifactGitVolume, artifactGitContract } from '../symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
import {
  ArtifactPodmanContext,
  SqliteArtifactLeaseHost,
  volumeEvidence,
} from '../symposium-artifact-host.js';
import {
  confirmOwnedArtifactSuccessor,
  withOwnedArtifactSuccessor,
} from '../symposium-owned-successor.js';
import type { ArtifactGenerationRequest } from '../symposium-artifact-generations.js';
import {
  sealImportedSourceArtifact,
  requireCompletedImportedSourceSeal,
  initialSourceExportReceipt,
  requireInitialSourceExport,
} from '../symposium-source-artifact-seal.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as runtime } from '../symposium-owned-runtime-contract.js';
import { SYMPOSIUM_ARTIFACT_TARGET as target } from '../symposium-artifact-lease.js';
const physical = process.env.MITZO_SOURCE_PHYSICAL_CONTRACT === '1';
it.skipIf(!physical)(
  'imports approved local history through the mounted API and exact stdin helper transport',
  async () => {
    const sourceReceipt = () => {
      execFileSync('git', ['diff', '--quiet', 'HEAD']);
      return {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
        trackedClean: true,
      };
    };
    const sourceBefore = sourceReceipt();
    const root = mkdtempSync(join(tmpdir(), 'mitzo-source-contract-')),
      repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim();
    git('init', '--quiet', '--template=', '--initial-branch=main');
    writeFileSync(join(repo, 'first.txt'), 'first\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'first');
    writeFileSync(join(repo, 'second.txt'), 'second\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'second');
    git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    writeFileSync(join(repo, 'untracked-private.txt'), 'must not be copied');
    const selectedBefore = {
      commit: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      config: readFileSync(join(repo, '.git/config'), 'utf8'),
      status: git('status', '--porcelain'),
    };
    const command = async (args: readonly string[], input?: Buffer) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
        env: { HOME: process.env.HOME, PATH: process.env.PATH },
        input,
        encoding: 'utf8',
        timeout: args[0] === 'start' ? 60000 : 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
    const owner = symposiumArtifactOwner(runtime.build.image),
      sessionId = randomUUID(),
      workspace = 'source-contract',
      database = join(root, 'custody.db');
    const volumes: string[] = [],
      helpers: string[] = [];
    const artifacts = new SymposiumSessionArtifacts(database, workspace, root, () => {}, {
      initializationContract: artifactGitContract(owner),
      initializerRequired: true,
      inspect: async (name) => {
        const rows = JSON.parse(
          await command(['volume', 'ls', '--filter', `name=^${name}$`, '--format', 'json']),
        );
        return rows.length
          ? volumeEvidence(JSON.parse(await command(['volume', 'inspect', name])), name)
          : null;
      },
      create: (name, labels, receipt) => {
        volumes.push(name);
        return createArtifactGitVolume(name, labels, owner, command, () => {}, receipt);
      },
    });
    let completed = false;
    try {
      expect(await artifacts.ensure(sessionId)).toEqual({ state: 'ready' });
      const mapping = artifacts.getReady(sessionId)!;
      const config = {
        version: 2,
        revision: 1,
        state: 'draft',
        anchorSeatId: 'seat',
        activeSeatCap: 1,
        seats: [
          {
            id: 'seat',
            name: 'Fixture',
            model: 'luna',
            systemPrompt: 'Fixture only',
            color: '#335577',
            role: 'coder',
          },
        ],
        turnRules: { mode: 'directed', maxTurns: 1 },
        interceptMode: 'manual',
      };
      const facts = {
        getSession: () => ({ sessionType: 'symposium', symposiumConfig: JSON.stringify(config) }),
      };
      const host = createSymposiumSourceHost({
        artifacts,
        workspace,
        owner,
        facts: facts as never,
        custody: () => {},
        command,
      });
      const app = express();
      app.use(express.json(), authMiddleware);
      app.use(
        '/api/sessions/:id/symposium/source',
        createSymposiumSourceRouter({
          repositories: () => ({ fixture: repo }),
          getSession: facts.getSession as never,
          getHost: () => host,
        }),
      );
      const token = (await login('test-passphrase-for-vitest'))!;
      const base = `/api/sessions/${sessionId}/symposium/source`;
      const post = (path: string, body: object, csrf = '') =>
        request(app)
          .post(base + path)
          .set('Authorization', `Bearer ${token}`)
          .set('x-csrf-token', csrf)
          .send(body);
      const preview = await post('/preview', {
        repositoryId: 'fixture',
        targetRepository: 'example/project',
        baseBranch: 'main',
        featureBranch: 'symposium/change',
      });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      const auth = await post('/reauthorize', { passphrase: 'test-passphrase-for-vitest' });
      expect(auth.status).toBe(200);
      const imported = await post(
        '/import',
        {
          plan: preview.body.plan,
          expectedRevision: preview.body.expectedRevision,
          expectedGeneration: preview.body.expectedGeneration,
          operationId: randomUUID(),
          confirmation: 'IMPORT COMMITTED REPOSITORY HISTORY',
        },
        auth.body.csrf,
      );
      expect(imported.status, JSON.stringify(imported.body)).toBe(200);
      expect(host.status(sessionId)).toMatchObject({
        state: 'imported',
        available: false,
        admissionIssued: false,
      });
      // Exercise the actual retained source fence, physical read-only exporter,
      // and same-helper recovery after an injected pre-start interruption.
      const sealOperationId = imported.body.operationId as string;
      let interruptBeforeStart = true;
      const sealCommand = async (args: readonly string[], maxOutputBytes = 16 * 1024 * 1024) => {
        if (args[0] === 'start' && interruptBeforeStart) {
          interruptBeforeStart = false;
          throw Error('fixture interruption after physical helper create');
        }
        return execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
          env: { HOME: process.env.HOME, PATH: process.env.PATH },
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: maxOutputBytes,
        });
      };
      const sealDeps = {
        artifacts,
        owner,
        workspace,
        custody: () => {},
        assertNoNativeClaims: () => {},
        command: sealCommand,
      };
      await expect(
        sealImportedSourceArtifact(
          sealDeps,
          sessionId,
          sealOperationId,
          new AbortController().signal,
        ),
      ).rejects.toThrow('fixture interruption');
      const pendingSeal = artifacts.sourceSealStatus(sessionId)!;
      expect(pendingSeal).toMatchObject({
        state: 'pending',
      });
      expect(pendingSeal.helperRemoved).not.toBe(true);
      expect(pendingSeal.helperId).toMatch(/^[a-f0-9]{64}$/);
      helpers.push(pendingSeal.helperId!);
      const completedSeal = await sealImportedSourceArtifact(
        sealDeps,
        sessionId,
        sealOperationId,
        new AbortController().signal,
      );
      expect(completedSeal).toMatchObject({
        state: 'complete',
        helperId: pendingSeal.helperId,
        helperRemoved: true,
        terminal: { helperId: pendingSeal.helperId, exitCode: 0 },
      });
      const retainedSource = requireCompletedImportedSourceSeal(artifacts, owner, sessionId);
      const exported = initialSourceExportReceipt(retainedSource, 'initial-physical-export');
      expect(exported.bundle.length).toBeGreaterThan(0);
      await requireInitialSourceExport(
        {
          artifacts,
          owner,
          workspace,
          custody: () => {},
          assertNoNativeClaims: () => {},
          command: sealCommand,
        },
        exported.receipt,
        exported.bundle,
        new AbortController().signal,
      );
      const copyCommand = async (
        args: readonly string[],
        maxOutputBytes = 16 * 1024 * 1024,
        input?: Buffer,
      ) =>
        execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
          env: { HOME: process.env.HOME, PATH: process.env.PATH },
          input,
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: maxOutputBytes,
        });
      const gateway = {
        workspace,
        stateDirectory: root,
        verifyCustody() {},
        async verifyCustodyAsync() {},
      };
      const leaseHost = new SqliteArtifactLeaseHost(
        database,
        {
          verifyGateway: async () => {},
          verifyMount: async () => {},
          verifyDeleted: async () => {},
        },
        new ArtifactPodmanContext(copyCommand),
        gateway as never,
      );
      let initialChild: { volumeName: string; generationId: string } | undefined;
      let chargedPreparation: unknown;
      let initialAdmission: unknown;
      let boundAttempt: unknown;
      let deliveryControl: unknown;
      let preSealGate: unknown;
      let dispatchedInitial: unknown;
      let reviewComposition:
        ReturnType<typeof createSymposiumProductionReviewComposition> | undefined;
      let reviewCoordinator: SymposiumReviewCoordinator | undefined;
      const nativeChild: unknown[] = [];
      const events = new EventStore(database);
      const reviews = new SymposiumReviewStore(database);
      try {
        const parentGit = retainedSource.receipt.git;
        const actor = 'fixture-owner';
        const accountBinding = {
          accountId: 'fixture-account',
          accountLabel: 'Fixture account (no call)',
          provider: 'openai-codex' as const,
          model: 'luna-fixture-no-calls',
          profileRevision: '1',
        };
        const seat = (id: string, role: 'coder' | 'reviewer') => ({
          id,
          name: id,
          role,
          model: accountBinding.model,
          systemPrompt: 'Credential-free physical contract',
          color: '#335577',
          accountBinding: {
            ...accountBinding,
            accountId: role === 'coder' ? accountBinding.accountId : `${id}-account`,
          },
          profileBinding: { profileId: role, profileRevision: '1' },
          contextGrant: {
            grantId: role === 'coder' ? 'fixture-context' : `context-${id}`,
            revision: 1,
            classification: 'work' as const,
            sourceRefs: ['repo:fixture'],
          },
          authorityGrant: {
            grantId: role === 'coder' ? 'fixture-grant' : `authority-${id}`,
            revision: 1,
            filesystem: role === 'coder' ? ('write' as const) : ('read' as const),
            tools: role === 'coder' ? ('write' as const) : ('read' as const),
            network: 'restricted' as const,
          },
          isolationRequest: {
            trustDomainId: 'fixture',
            revision: 1,
            placement: 'reuse-compatible' as const,
          },
        });
        const activeConfig: SymposiumConfig = {
          version: 2,
          revision: 1,
          state: 'active',
          anchorSeatId: 'seat',
          activeSeatCap: 2,
          seats: [seat('seat', 'coder'), seat('reviewer', 'reviewer')],
          turnRules: { mode: 'directed', maxTurns: 4 },
          interceptMode: 'manual',
        };
        events.upsertSession({ sessionId, accountBinding: activeConfig.seats[0].accountBinding });
        events.setSymposiumConfig(sessionId, activeConfig);
        for (const seatId of ['seat', 'reviewer']) {
          events.transitionSymposiumMembership({
            sessionId,
            seatId,
            action: 'admit',
            expectedGeneration: 0,
            configRevision: 1,
            actor,
            reason: 'Physical fixture admission',
            idempotencyKey: `fixture-admit-${seatId}`,
            occurredAt: Date.now(),
          });
          events.markSymposiumMembershipReconciled(sessionId, seatId, 1, 'confirmed');
        }
        const authority = createSymposiumSuccessorFixAuthority({
          workflows: reviews,
          events,
          grants: { verifySeat: () => {} },
        });
        const deps = {
          authority,
          gateway: gateway as never,
          leaseHost,
          sessionArtifacts: artifacts,
          sealer: {} as never,
          sourceOwner: owner,
          sourceProof: { assertNoNativeClaims: () => {}, command: sealCommand },
        };
        const nativeSink = new SymposiumNativeEventSink(events, () => {});
        let writerOutput: string[] | undefined;
        let acceptedExecution: SymposiumSeatExecution | undefined;
        const orchestrator = new SymposiumOrchestrator({
          store: events,
          executors: {
            seat: {
              execute: async (execution: SymposiumSeatExecution) => {
                expect(execution.provenance).toMatchObject({ version: 3 });
                expect(execution.claimToken).toMatch(/^[0-9a-f-]{36}$/);
                acceptedExecution = execution;
                expect(
                  events.markSymposiumRecipientAccepted({
                    deliveryId: execution.deliveryId,
                    seatId: execution.seat.id,
                    claimToken: execution.claimToken,
                    providerThreadId: 'offline-physical-thread',
                    providerTurnId: 'offline-physical-turn',
                    acceptedAt: Date.now(),
                  }),
                ).toBe(true);
                writerOutput = await physicalWriter();
                nativeSink.record(execution, {
                  type: 'stream_event',
                  event: { type: 'message_start', message: { id: 'offline-physical-message' } },
                });
                nativeSink.record(execution, { type: 'result', usage_status: 'unknown' });
                return {
                  providerThreadId: 'offline-physical-thread',
                  content: 'offline physical write',
                  costUsd: 0,
                };
              },
            },
          },
          artifactReady: (id, seatId, generation) =>
            Boolean(events.getSymposiumArtifactReference(id, seatId, generation)),
        });
        const composition = createSymposiumProductionReviewComposition({
          host: {
            gateway,
            sourceImport: {
              requireSeal: () => requireCompletedImportedSourceSeal(artifacts, owner, sessionId),
              initialExport: (_sessionId: string, operationId: string) =>
                initialSourceExportReceipt(
                  requireCompletedImportedSourceSeal(artifacts, owner, sessionId),
                  operationId,
                ),
            },
            sealSessionArtifacts: async () => {
              throw Error('No model-backed sealing in fixture');
            },
            requireCompletedArtifactSeal: async () => {
              throw Error('No writer seal in fixture');
            },
            inspectCompletedArtifact: async () => {
              throw Error('No writer inspection in fixture');
            },
            exportSuccessorArtifactBundle: async () => {
              throw Error('No fix export in fixture');
            },
            copySuccessorArtifact: async (
              request: ArtifactGenerationRequest,
              receipt: typeof exported.receipt,
              bundle: Buffer,
              signal: AbortSignal,
            ) => {
              expect(() =>
                authority.assertCurrent({
                  ...request,
                  policyReservationId: 'uncharged-reservation',
                } as ArtifactGenerationRequest),
              ).toThrow('Charged exact initial source preparation required');
              expect(authority.assertCurrent(request)).toBe(true);
              const copied = await withOwnedArtifactSuccessor(
                deps,
                request,
                receipt,
                bundle,
                (copier) => copier.copy(request, receipt, bundle, signal),
              );
              initialChild = copied;
              volumes.push(copied.volumeName);
              return copied;
            },
            admitSuccessorArtifact: async (
              request: ArtifactGenerationRequest,
              binding: ArtifactAdmissionBindingV1,
              receipt: typeof exported.receipt,
              bundle: Buffer,
            ) => {
              initialAdmission = await withOwnedArtifactSuccessor(
                deps,
                request,
                receipt,
                bundle,
                (_copier, ledger) =>
                  Promise.resolve(
                    confirmOwnedArtifactSuccessor(
                      events,
                      ledger,
                      binding,
                      (selected) => authority.assertAdmissionCurrent!(selected),
                      (selected) => {
                        expect(selected.sourceSealId).toBe(sealOperationId);
                        expect(selected.parentSealDigest).toBe(retainedSource.digest);
                        return true;
                      },
                    ),
                  ),
              );
              return initialAdmission as { reference: never; receipt: unknown };
            },
            inspectStoppedSuccessorOperation: () => null,
            assertArtifactAdmissionCurrent: (id: string, reference: never) =>
              events.assertSymposiumArtifactAdmissionCurrent(id, reference),
            artifactLeaseHost: leaseHost,
            attemptRegistry: { observations: new Map(), get: () => null },
            currentProfiles: () => ({ resume: () => {}, validateModelSelection: () => {} }),
          },
          events,
          reviews,
          grants: { verifySeat: () => {} },
          actionAuthority: { authorize: () => null },
          artifactResultsPath: database,
          runtime: () => orchestrator,
          retainedRuntime: () => null,
        } as never);
        reviewComposition = composition;
        const context = { owner: actor, sessionId };
        const coordinator = new SymposiumReviewCoordinator(reviews, composition.reviewHost);
        reviewCoordinator = coordinator;
        expect(
          coordinator.startApplicationRun(context, {
            workflowId: 'workflow',
            acceptanceCriteria: ['criterion.txt contains INITIAL_CHILD_NATIVE'],
            limits: {
              version: 1,
              mode: 'application',
              maxHostTurns: 4,
              maxReviewCycles: 1,
              deadlineAt: Date.now() + 240_000,
              noProgressLimit: 1,
            },
            expectedArtifactRevision: parentGit.commit,
            expectedArtifactHash: parentGit.committedTreeDigest,
          }),
        ).toMatchObject({ status: 'awaiting_initial', hostTurns: 0 });
        expect(
          await coordinator.reserveWithTransition(
            context,
            'workflow',
            'initial',
            'initial-attempt',
          ),
        ).toMatchObject({ kind: 'reserved_not_dispatched', attemptId: 'initial-attempt' });
        const retainedCharge = reviews.get('workflow')!;
        expect(retainedCharge).toMatchObject({
          hostTurns: 1,
          applicationPreparations: [
            { kind: 'initial', status: 'bound', attemptId: 'initial-attempt' },
          ],
        });
        chargedPreparation = retainedCharge.applicationPreparations[0];
        boundAttempt = retainedCharge.applicationAttempts[0];
        expect(boundAttempt).toMatchObject({ kind: 'initial', dispatched: false });
        const delivery = events.getSymposiumDelivery(
          retainedCharge.applicationAttempts[0].binding.deliveryId,
        );
        expect(delivery).toMatchObject({
          configRevision: 2,
          recipients: [{ seatId: 'seat', membershipGeneration: 2 }],
        });
        deliveryControl = events.getSymposiumApplicationDeliveryControl(delivery!.deliveryId);
        expect(deliveryControl).toMatchObject({
          workflowId: 'workflow',
          attemptId: 'initial-attempt',
        });
        expect(initialChild).toBeDefined();
        expect(
          events.getSymposiumArtifactAdmission(
            sessionId,
            retainedCharge.applicationPreparations[0].transitionId,
          ),
        ).toMatchObject({ receipt: { pointerRevision: 1 } });
        // Keep the exact production composition live for the post-write
        // observation gate below; the outer finally closes it.
        const copied = initialChild!;
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const native = (
          mount: 'rw' | 'ro',
          access: 'read' | 'write',
          code: string,
          exit: number,
        ) => {
          const claim = createHash('sha256').update(randomUUID()).digest('hex');
          const script = `set -eu; /usr/local/bin/symposium-attempt-controller run ${claim} ${access} /usr/bin/python3 -I -B -c ${quote(code)}; /usr/bin/cat /sandbox/.symposium-control/${claim}.done`;
          const lines = copyCommand([
            'run',
            '--rm',
            '--pull=never',
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--timeout=20',
            '--user',
            'sandbox',
            '--tmpfs',
            '/sandbox:rw,mode=1777',
            '--volume',
            `${copied.volumeName}:${target}:${mount}`,
            '--entrypoint=/bin/bash',
            owner.image,
            '-c',
            script,
          ]);
          return lines.then((value) => {
            const output = value.trim().split('\n');
            const receipt = JSON.parse(output.pop()!);
            expect(receipt).toMatchObject({ claim, terminal: true, exit_code: exit });
            nativeChild.push({ mount, access, receipt, output });
            return output;
          });
        };
        const childGit = `import subprocess\nfrom pathlib import Path\nr='${target}'\nenv={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}\ndef git(*args): return subprocess.check_output(['/usr/bin/git','-C',r,*args],env=env,text=True).strip()\n`;
        const physicalWriter = () =>
          native(
            'rw',
            'write',
            childGit +
              `Path(r+'/criterion.txt').write_text('INITIAL_CHILD_NATIVE\\n')\ngit('add','criterion.txt')\ngit('-c','user.name=Contract','-c','user.email=contract@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Initial child native write')\nprint(git('rev-parse','HEAD'))`,
            0,
          );
        const charged = reviews.get('workflow')!.applicationAttempts[0];
        const permit = createHash('sha256')
          .update('symposium-application-delivery-permit/v1\0')
          .update(charged.binding.claimToken)
          .update('\0')
          .update(charged.binding.deliveryId)
          .update('\0')
          .update('0')
          .digest('hex');
        events.armSymposiumApplicationDelivery({
          deliveryId: charged.binding.deliveryId,
          expectedEpoch: 0,
          permit,
        });
        orchestrator.intervene({
          deliveryId: charged.binding.deliveryId,
          action: 'approve',
          idempotencyKey: 'physical-initial-approve',
          applicationPermit: permit,
        });
        const delivered = await orchestrator.deliver(charged.binding.deliveryId, {
          applicationPermit: permit,
        });
        expect(delivered).toMatchObject({ status: 'delivered', recipients: [{ error: null }] });
        expect(events.getSessionEvents(sessionId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'message_start',
              symposiumProvenance: expect.objectContaining({ version: 3 }),
            }),
          ]),
        );
        dispatchedInitial = {
          deliveryId: delivered.deliveryId,
          status: delivered.status,
          nativeClaim: acceptedExecution?.claimToken,
          provenance: acceptedExecution?.provenance,
          recipient: delivered.recipients[0],
        };
        expect(writerOutput).toBeDefined();
        expect(writerOutput![0]).toMatch(/^[a-f0-9]{40}$/);
        const readerOutput = await native(
          'ro',
          'read',
          childGit +
            `print(Path(r+'/criterion.txt').read_text().strip())\nprint(git('rev-parse','HEAD'))`,
          0,
        );
        expect(readerOutput).toEqual(['INITIAL_CHILD_NATIVE', writerOutput![0]]);
        const denied = `from pathlib import Path\ntry:\n Path('${target}/forbidden').write_text('bad')\nexcept OSError as e:\n print('DENIED_'+str(e.errno))\n raise SystemExit(1)\nraise SystemExit(0)`;
        expect((await native('ro', 'write', denied, 1))[0]).toMatch(/^DENIED_(13|30)$/);
        expect((await native('rw', 'read', denied, 1))[0]).toBe('DENIED_13');
        // A real physical write and independent read do not stand in for the
        // trusted native provider completion, execution observation or seal.
        // The application workflow must stay before reviewer admission.
        const reviewContext = { owner: actor, sessionId };
        const initialDecision = reviewCoordinator!.recordInitialResult(
          reviewContext,
          'workflow',
          'initial-attempt',
        );
        expect(initialDecision).toMatchObject({
          kind: 'decision_required',
          code: 'host_initial_receipt_required',
        });
        await expect(
          reviewCoordinator!.reserveWithTransition(
            reviewContext,
            'workflow',
            'review',
            'premature-review',
          ),
        ).rejects.toThrow('Current artifact seal unavailable');
        expect(reviews.get('workflow')).toMatchObject({
          status: 'awaiting_initial',
          hostTurns: 1,
          reviewCycles: 0,
        });
        expect(reviews.get('workflow')!.applicationAttempts).toHaveLength(1);
        preSealGate = {
          initialResult: initialDecision,
          reviewerPreparation: 'denied:Current artifact seal unavailable',
          hostTurns: 1,
          reviewCycles: 0,
          retainedAttempts: 1,
        };
      } finally {
        reviewComposition?.close();
        reviews.close();
        events.close();
        leaseHost.close();
      }
      const db = new Database(database, { readonly: true });
      const row = db
        .prepare('SELECT * FROM symposium_session_artifacts WHERE session_id=?')
        .get(sessionId) as Record<string, unknown>;
      db.close();
      const importedState = JSON.parse(row.source_import_json as string);
      expect(importedState.helperRemoved).toBe(true);
      expect(importedState.receipt.terminal).toEqual({
        helperId: importedState.helperId,
        exitCode: 0,
      });
      helpers.push(importedState.helperId);
      const code = `import subprocess,json,pathlib\nr='${target}'\ndef git(*args): return subprocess.check_output(['/usr/bin/git','-C',r,*args],env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'},text=True).strip()\nassert not pathlib.Path(r+'/untracked-private.txt').exists()\nprint(json.dumps({'commit':git('rev-parse','HEAD'),'tree':git('rev-parse','HEAD^{tree}'),'history':git('rev-list','--count','HEAD'),'base':git('rev-parse','refs/remotes/origin/main'),'default':git('symbolic-ref','refs/remotes/origin/HEAD'),'branch':git('symbolic-ref','HEAD'),'origin':git('config','--get','remote.origin.url'),'first':pathlib.Path(r+'/first.txt').read_text(),'second':pathlib.Path(r+'/second.txt').read_text()}))`;
      const verifyId = (
        await command([
          'create',
          '--pull=never',
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--timeout=20',
          '--user',
          '998:998',
          '--mount',
          `type=volume,src=${mapping.volumeName},dst=${target},readonly`,
          '--entrypoint=/usr/bin/python3',
          owner.image,
          '-I',
          '-B',
          '-c',
          code,
        ])
      ).trim();
      expect(verifyId).toMatch(/^[a-f0-9]{64}$/);
      helpers.push(verifyId);
      const verified = JSON.parse(await command(['start', '--attach', verifyId]));
      const [terminal] = JSON.parse(await command(['inspect', verifyId]));
      expect(terminal.State).toMatchObject({ Running: false, ExitCode: 0 });
      await command(['rm', verifyId]);
      expect(verified).toEqual({
        commit: selectedBefore.commit,
        tree: selectedBefore.tree,
        history: '2',
        base: selectedBefore.commit,
        default: 'refs/remotes/origin/main',
        branch: 'refs/heads/symposium/change',
        origin: 'https://github.com/example/project.git',
        first: 'first\n',
        second: 'second\n',
      });
      expect({
        commit: git('rev-parse', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        config: readFileSync(join(repo, '.git/config'), 'utf8'),
        status: git('status', '--porcelain'),
      }).toEqual(selectedBefore);
      expect(sourceReceipt()).toEqual(sourceBefore);
      if (initialChild) await command(['volume', 'rm', initialChild.volumeName]);
      await command(['volume', 'rm', mapping.volumeName]);
      completed = true;
      writeFileSync(
        join(root, 'evidence.json'),
        JSON.stringify(
          {
            completed,
            sourceBefore,
            sourceAfter: sourceReceipt(),
            selectedBefore,
            preview: preview.body,
            importedState,
            pendingSeal,
            completedSeal,
            initialExportReceipt: exported.receipt,
            initialChild,
            chargedPreparation,
            initialAdmission,
            boundAttempt,
            deliveryControl,
            dispatchedInitial,
            preSealGate,
            nativeChild,
            verified,
            mapping,
            helpers,
            cleanupComplete: true,
            modelCalls: 0,
            remoteFetch: false,
            applicationCredentials: false,
            simulatedBoundary:
              'production review composition, charged initial preparation, real Podman child, two-owner admission, claim-v3 orchestrator dispatch, synthetic provider acceptance/result through real native event sink, native controller writer commit, independent read-only physical probe and fail-closed pre-seal reviewer gate; disposable app passphrase/custody; owned gateway, actual provider result, physical writer seal, positive reviewer transition, budget and publication remain untested',
          },
          null,
          2,
        ),
      );
      console.log(`Physical source evidence: ${root}/evidence.json`);
    } finally {
      artifacts.close();
      if (!completed) {
        writeFileSync(
          join(root, 'retained.json'),
          JSON.stringify({ volumes, helpers, completed: false }, null, 2),
        );
        console.error(`Retained exact physical source fixture: ${root}`);
      }
    }
  },
  240000,
);
