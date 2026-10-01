/** Credential-free physical source → writer seal → independent reader → accepted
 * finding → successor fix → delta → byte criterion → immutable record. Production
 * reservations, claims, permits, controllers and filesystem/custody transitions are
 * real; account/gateway attestation, manager transport and model replies are synthetic.
 * Every disposable Podman container has network none; no provider call or publication. */
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import { createSymposiumProductionReviewComposition } from '../symposium-production-review-composition.js';
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
import { inspectStoppedSuccessorOperation } from '../symposium-artifact-generations.js';
import {
  completedPublicationArtifact,
  completedSealHash,
  publicationSealFenceForRecord,
} from '../symposium-publication-artifact.js';
import {
  SealedPublicationAuthority,
  type PublicationCredentialHandle,
} from '../symposium-sealed-publication-authority.js';
import { SealedPublicationService } from '../symposium-sealed-publication-service.js';
import { CapabilityOperationStore } from '../connections/capabilities/operation-store.js';
import {
  sealImportedSourceArtifact,
  requireCompletedImportedSourceSeal,
  initialSourceExportReceipt,
  requireInitialSourceExport,
} from '../symposium-source-artifact-seal.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as runtime } from '../symposium-owned-runtime-contract.js';
import { SYMPOSIUM_ARTIFACT_TARGET as target } from '../symposium-artifact-lease.js';
import { controlledAttemptArgv, verifyControllerProof } from '../symposium-attempt-transport.js';
import { AccountProfiles } from '../account-profiles.js';
import { createSymposiumSessionRuntime } from '../symposium-session-runtime.js';
import { SymposiumAttemptRegistry } from '../symposium-attempt-registry.js';
import { PhysicalArtifactSealer } from '../symposium-physical-artifact-seal.js';
import { OpenShellRuntimeManager, sandboxNameForConversation } from '../openshell-runtime.js';
import {
  createSymposiumApplicationDispatchPolicy,
  selectSymposiumApplicationClaim,
} from '../symposium-application-dispatch.js';
import { SymposiumReviewActionAuthority } from '../symposium-review-action-authority.js';
const physical = process.env.MITZO_APPLICATION_PHYSICAL_CONTRACT === '1';
const sourceApiOnly = process.env.MITZO_APPLICATION_SOURCE_API_ONLY === '1';
it.skipIf(!physical)(
  sourceApiOnly
    ? 'qualifies physical source API only; application lifecycle unexercised'
    : 'completes production application owners with physical artifacts and deterministic model transport',
  async () => {
    const sourceReceipt = () => {
      return {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
        dirtyStatus: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
        trackedDiffSha256: createHash('sha256')
          .update(execFileSync('git', ['diff', 'HEAD', '--binary']))
          .digest('hex'),
      };
    };
    const sourceBefore = sourceReceipt();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-application-contract-'))),
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
      workspace = 'application-contract',
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
            model: 'offline-source-fixture',
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
        // Disposable draft lookup only; application memberships/admissions below use EventStore.
        facts: facts as unknown as Parameters<typeof createSymposiumSourceHost>[0]['facts'],
        custody: () => {},
        command,
      });
      const app = express();
      const lifecycle: Array<{ path: string; event: string; status?: number }> = [];
      const retainLifecycle = (path: string, event: string, status?: number) => {
        lifecycle.push({ path, event, status });
        writeFileSync(join(root, 'source-api-lifecycle.json'), JSON.stringify(lifecycle, null, 2));
      };
      app.use((req, res, next) => {
        const path = req.path.split('/').at(-1)!;
        req.once('aborted', () => retainLifecycle(path, 'request-aborted'));
        req.once('close', () => retainLifecycle(path, 'request-close'));
        req.once('error', () => retainLifecycle(path, 'request-error'));
        res.once('finish', () => retainLifecycle(path, 'response-finish', res.statusCode));
        res.once('close', () => retainLifecycle(path, 'response-close', res.statusCode));
        res.once('error', () => retainLifecycle(path, 'response-error', res.statusCode));
        next();
      });
      app.use(express.json(), authMiddleware);
      app.use(
        '/api/sessions/:id/symposium/source',
        createSymposiumSourceRouter({
          repositories: () => ({ fixture: repo }),
          getSession: facts.getSession as unknown as Parameters<
            typeof createSymposiumSourceRouter
          >[0]['getSession'],
          getHost: () => host,
        }),
      );
      const token = (await login('test-passphrase-for-vitest'))!;
      const base = `/api/sessions/${sessionId}/symposium/source`;
      const server = app.listen(0, '127.0.0.1');
      server.on('error', () => retainLifecycle('server', 'error'));
      server.once('close', () => retainLifecycle('server', 'close'));
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const sourceApi: Array<{ path: string; status?: number; error?: string }> = [];
      const post = async (path: string, body: object, csrf = '') => {
        try {
          const response = await request(server)
            .post(base + path)
            .set('Connection', 'close')
            .set('Authorization', `Bearer ${token}`)
            .set('x-csrf-token', csrf)
            .send(body);
          sourceApi.push({ path, status: response.status });
          writeFileSync(join(root, 'source-api.json'), JSON.stringify(sourceApi, null, 2));
          return response;
        } catch (error) {
          sourceApi.push({
            path,
            error: error instanceof Error ? error.message : 'Unknown local transport error',
          });
          writeFileSync(join(root, 'source-api.json'), JSON.stringify(sourceApi, null, 2));
          throw error;
        }
      };
      let imported: Awaited<ReturnType<typeof post>>;
      try {
        const preview = await post('/preview', {
          repositoryId: 'fixture',
          targetRepository: 'example/project',
          baseBranch: 'main',
          featureBranch: 'symposium/change',
        });
        expect(preview.status, JSON.stringify(preview.body)).toBe(200);
        const auth = await post('/reauthorize', { passphrase: 'test-passphrase-for-vitest' });
        expect(auth.status).toBe(200);
        imported = await post(
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
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      expect(host.status(sessionId)).toMatchObject({
        state: 'imported',
        available: false,
        admissionIssued: false,
      });
      if (sourceApiOnly) {
        writeFileSync(
          join(root, 'source-api-evidence.json'),
          JSON.stringify(
            {
              sourceApiOnly: true,
              sourceState: host.status(sessionId),
              completedApplication: false,
              modelCalls: 0,
              sourceBefore,
              selectedBefore,
              physicalVolumes: volumes,
              disposition: 'preserved imported source and original operation',
            },
            null,
            2,
          ),
        );
        return;
      }
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
      let loseWriterStopResponse = true;
      let loseReaderStopResponse = true;
      let loseReaderRetirementResponse = true;
      const injectedReaderFaults: string[] = [];
      let losePreVerifierCensusResponse = false;
      let armPreVerifierCensusResponse = true;
      const injectedSealFaults: string[] = [];
      const copyCommand = async (
        args: readonly string[],
        maxOutputBytes = 16 * 1024 * 1024,
        input?: Buffer,
      ) => {
        const output = execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
          env: { HOME: process.env.HOME, PATH: process.env.PATH },
          input,
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: maxOutputBytes,
        });
        if (
          losePreVerifierCensusResponse &&
          JSON.stringify(args) === JSON.stringify(['ps', '--all', '--no-trunc', '--format', 'json'])
        ) {
          losePreVerifierCensusResponse = false;
          injectedSealFaults.push('pre-verifier census response lost');
          throw Error('Injected lost pre-verifier census response');
        }
        return output;
      };
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
          verifyMount: async (name, id, config) => {
            const detail = JSON.parse(await copyCommand(['inspect', id]))[0];
            expect(detail.Name.replace(/^\//, '')).toBe(name);
            const expected = config.podman!.mounts[0];
            const mounted = detail.Mounts.filter(
              (mount: { Destination: string }) => mount.Destination === expected.target,
            );
            expect(mounted).toHaveLength(1);
            expect(mounted[0]).toMatchObject({ Name: expected.source, RW: !expected.read_only });
          },
          verifyDeleted: async (_name, id) => {
            const all = JSON.parse(
              await copyCommand(['ps', '--all', '--no-trunc', '--format', 'json']),
            );
            expect(all.some((row: { Id?: string; ID?: string }) => (row.Id ?? row.ID) === id)).toBe(
              false,
            );
            if (dispatches === 1 && armPreVerifierCensusResponse) {
              armPreVerifierCensusResponse = false;
              losePreVerifierCensusResponse = true;
            }
          },
        },
        new ArtifactPodmanContext(
          copyCommand,
          copyCommand,
          (args, onChunk) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
                env: { HOME: process.env.HOME, PATH: process.env.PATH },
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              let bytes = 0;
              const timer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(Error('Physical stream timeout'));
              }, 60_000);
              child.stdout.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 16 * 1024 * 1024) {
                  child.kill('SIGTERM');
                  reject(Error('Physical stream bound exceeded'));
                } else onChunk(chunk);
              });
              child.stderr.on('data', () => {});
              child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
              });
              child.once('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(Error('Physical stream failed'));
              });
            }),
        ),
        gateway as unknown as Parameters<typeof withOwnedArtifactSuccessor>[0]['gateway'],
      );
      const applicationDatabase = join(root, 'events.db');
      const events = new EventStore(applicationDatabase),
        reviews = new SymposiumReviewStore(applicationDatabase);
      const registryDirectory = join(root, 'native');
      mkdirSync(registryDirectory, { mode: 0o700 });
      const containers = new Map<string, string>();
      writeFileSync(
        join(root, 'resource-map.json'),
        JSON.stringify({ sessionId, volumes, containers: [] }),
      );
      const registry = new SymposiumAttemptRegistry(join(registryDirectory, 'claims.db'), {
        launch: () => {
          throw Error('Fixture launches only physical Podman controller');
        },
        confirm: async (sandbox, claim) => {
          const proof = await copyCommand([
            'exec',
            '--user',
            'sandbox',
            sandbox.sandboxName,
            ...controlledAttemptArgv('cancel', claim),
          ]);
          verifyControllerProof(proof, claim);
        },
      });
      const profiles = new AccountProfiles(
        ['coder', 'reviewer'].map((id) => ({
          id,
          label: id,
          provider: 'openai' as const,
          credentialRef: { provider: 'keychain' as const, service: 'unused', account: 'unused' },
          sandboxProvider: id,
          sandboxProviderId: id,
          models: [{ id: 'offline-model-transport', label: 'No inference' }],
        })),
      );
      const seat = (id: string, role: 'coder' | 'reviewer') => ({
        id,
        name: id,
        role,
        model: 'offline-model-transport',
        systemPrompt: 'Disposable fixture',
        color: '#335577',
        accountBinding: profiles.resolve(id, 'offline-model-transport'),
        profileBinding: { profileId: id, profileRevision: '1' },
        contextGrant: {
          grantId: `context-${id}`,
          revision: 1,
          classification: 'work' as const,
          sourceRefs: [],
        },
        authorityGrant: {
          grantId: `authority-${id}`,
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
      events.upsertSession({ sessionId, accountBinding: seat('coder', 'coder').accountBinding });
      events.setSymposiumConfig(sessionId, {
        version: 2,
        revision: 1,
        state: 'active',
        anchorSeatId: 'coder',
        activeSeatCap: 2,
        seats: [seat('coder', 'coder'), seat('reviewer', 'reviewer')],
        turnRules: { mode: 'directed', maxTurns: 12 },
        interceptMode: 'manual',
      });
      for (const seatId of ['coder', 'reviewer']) {
        events.transitionSymposiumMembership({
          sessionId,
          seatId,
          action: 'admit',
          expectedGeneration: 0,
          configRevision: 1,
          actor: 'fixture-owner',
          reason: 'Disposable admission',
          idempotencyKey: `admit-${seatId}`,
          occurredAt: Date.now(),
        });
        events.markSymposiumMembershipReconciled(sessionId, seatId, 1, 'confirmed');
      }
      const grants = { verifySeat: () => {} }; // Synthetic account/grant identity; not lifecycle receipts.
      const authority = createSymposiumSuccessorFixAuthority({
        workflows: reviews,
        events,
        grants,
      });
      const actionAuthority = new SymposiumReviewActionAuthority();
      const runtimeConfig = {
        cli: 'openshell',
        cliContract: 'v0.1' as const,
        image: owner.image,
        policy: '/fixture',
        seed: '/fixture',
        serviceProviders: [],
        grantableServiceProviders: [],
        workspace,
        gateway: 'fixture-gateway',
        gatewayInsecure: false,
        createDetached: true,
        sandboxIdLength: 13,
        workdir: target,
        webSearch: 'disabled' as const,
      };
      const inspect = async (name: string) => {
        const rows = JSON.parse(
          await copyCommand([
            'ps',
            '--all',
            '--no-trunc',
            '--filter',
            `name=^${name}$`,
            '--format',
            'json',
          ]),
        );
        if (!rows.length) return undefined;
        const detail = JSON.parse(await copyCommand(['inspect', rows[0].Id ?? rows[0].ID]))[0];
        if (
          typeof detail.Id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(detail.Id) ||
          detail.Name.replace(/^\//, '') !== name
        )
          throw Error('Exact Podman inventory identity invalid');
        return {
          id: detail.Id,
          name,
          phase: detail.State.Running ? ('Ready' as const) : ('Stopped' as const),
        };
      };
      vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectReserved').mockImplementation(
        async (runtimeId) => await inspect(sandboxNameForConversation(runtimeId, 13)),
      );
      const artifactRequest = (
        id: string,
        seatId: string,
        generation: number,
        purpose = 'admission',
      ) => {
        const ref = events.getSymposiumArtifactReference(id, seatId, generation)!;
        if (!ref) throw Error('Exact artifact pointer missing');
        const reader =
          'kind' in ref
            ? events.getSymposiumSealedReaderAdmission(id, ref.readerAdmissionId)
            : null;
        const writer = !('kind' in ref)
          ? events.getSymposiumArtifactAdmission(id, ref.transitionId)
          : null;
        if (purpose === 'cleanup') {
          const record = events.getSymposiumSeatSandbox(id, seatId, generation);
          if (!record || record.workspace !== workspace)
            throw Error('Exact retained cleanup record required');
          const request = leaseHost.retainedCleanupRequest(record);
          const volumeName = reader ? reader.binding.volumeName : writer!.binding.childVolumeName;
          if (
            !request ||
            request.volumeName !== volumeName ||
            request.volumeGeneration !== ref.artifactGenerationId
          )
            throw Error('Retained physical cleanup mapping changed');
          return request;
        }

        return {
          sessionId: id,
          seatId,
          workspaceId: workspace,
          driver: 'podman' as const,
          volumeName: reader ? reader.binding.volumeName : writer!.binding.childVolumeName,
          volumeGeneration: ref.artifactGenerationId,
          access: reader ? ('reviewer' as const) : ('writer' as const),
          ...(reader ? { readerAdmissionId: reader.binding.readerAdmissionId } : {}),
        };
      };
      let retained: ReturnType<typeof createSymposiumSessionRuntime> | null = null;
      let runtimeCreations = 0;
      let dispatches = 0;
      let loseSealVerificationResponse = true;
      let losePhysicalSealResponse = true;
      const policy = createSymposiumApplicationDispatchPolicy({
        store: reviews,
        observations: registry.observations,
        assertArtifactCurrent: (_attempt, execution) => {
          const ref =
            'version' in execution.provenance && execution.provenance.version === 3
              ? execution.provenance.artifact
              : null;
          if (!ref) throw Error('Claim v3 artifact missing');
          if ('kind' in ref)
            composed.assertReaderAdmissionCurrent(
              events.assertSymposiumSealedReaderAdmissionCurrent(execution.sessionId, ref),
            );
          else events.assertSymposiumArtifactAdmissionCurrent(execution.sessionId, ref);
        },
      });
      const getRuntime = () => {
        if (retained) return retained;
        runtimeCreations += 1;
        retained = createSymposiumSessionRuntime({
          sessionId,
          store: events,
          profiles,
          hostGrants: grants,
          // Subscription execution is outside this API-only synthetic transport fixture.
          codexStore: {} as Parameters<typeof createSymposiumSessionRuntime>[0]['codexStore'],
          resolveProviderIdentity: (name, id) => ({ name, id, type: 'openai', workspace }),
          runtimeConfig,
          perSeatSandboxVerified: true,
          readOnlyEnforced: { openaiApi: true, claudeVertex: false },
          applicationPolicy: policy,
          attemptRegistry: registry,
          artifactLeaseHost: leaseHost,
          artifactRequest,
          claimIdFactory: (input) => {
            const claim = selectSymposiumApplicationClaim(reviews, input);
            if (!claim) throw Error('Application claim required');
            return claim;
          },
          assertArtifactAdmissionCurrent: (id, ref) => {
            if ('kind' in ref)
              composed.assertReaderAdmissionCurrent(
                events.assertSymposiumSealedReaderAdmissionCurrent(id, ref),
              );
            else events.assertSymposiumArtifactAdmissionCurrent(id, ref);
          },
          recordAccepted: (input) => events.markSymposiumRecipientAccepted(input),
          managerFactory: (config) => ({
            ensure: async (runtimeId, _signal, expected) => {
              if (expected) return { ...expected, workdir: target };
              const name = sandboxNameForConversation(runtimeId, 13);
              const mount = config.artifactDriverConfig!.podman!.mounts[0];
              const id = (
                await copyCommand([
                  'create',
                  '--pull=never',
                  '--name',
                  name,
                  '--network=none',
                  '--read-only',
                  '--cap-drop=ALL',
                  '--security-opt=no-new-privileges',
                  '--user',
                  'sandbox',
                  '--pids-limit=64',
                  '--memory=256m',
                  '--tmpfs',
                  '/sandbox:rw,mode=1777',
                  '--mount',
                  `type=volume,src=${mount.source},dst=${mount.target}${mount.read_only ? ',readonly' : ''}`,
                  '--entrypoint=/bin/sleep',
                  owner.image,
                  '300',
                ])
              ).trim();
              containers.set(name, id);
              writeFileSync(
                join(root, 'resource-map.json'),
                JSON.stringify({ sessionId, volumes, containers: [...containers] }, null, 2),
              );
              await copyCommand(['start', id]);
              return { sandboxName: name, sandboxId: id, workdir: target };
            },
            inspect: async (runtimeId, id) => {
              const detail = await inspect(sandboxNameForConversation(runtimeId, 13));
              if (!detail) return undefined;
              if (detail.id !== id) throw Error('Exact physical seat identity changed');
              return detail;
            },
            inspectReserved: async (runtimeId) =>
              inspect(sandboxNameForConversation(runtimeId, 13)),
            stop: async (_runtimeId, id) => {
              await copyCommand(['stop', id]);
              if (dispatches === 1 && loseWriterStopResponse) {
                loseWriterStopResponse = false;
                injectedSealFaults.push('original writer stop response lost');
                throw Error('Injected lost original writer stop response');
              }
              if (dispatches === 2 && loseReaderStopResponse) {
                loseReaderStopResponse = false;
                injectedReaderFaults.push('original reader stop response lost');
                throw Error('Injected lost original reader stop response');
              }
            },
            delete: async (_runtimeId, id) => {
              await copyCommand(['rm', id]);
            },
          }),
          openNative: async ({ sandbox, execution, onEvent }) => ({
            run: async (_input, callbacks) => {
              callbacks.beforeDispatch();
              registry.reserve({
                ...execution,
                sandbox,
                artifact:
                  'version' in execution.provenance && execution.provenance.version === 3
                    ? execution.provenance.artifact
                    : undefined,
              });
              dispatches++;
              const thread = execution.providerThreadId ?? `thread-${execution.seat.id}`;
              const turn = `turn-${execution.claimToken}`;
              registry.observations.accept({
                claimToken: execution.claimToken,
                sessionId,
                seatId: execution.seat.id,
                membershipGeneration: execution.provenance.membershipGeneration!,
                accountBinding: execution.seat.accountBinding!,
                provenance: execution.provenance,
                providerThreadId: thread,
                providerTurnId: turn,
              });
              callbacks.accepted(thread, turn);
              const attempt = reviews.applicationAttemptForClaim(execution.claimToken)!;
              const writer = ['initial', 'fix'].includes(attempt.kind);
              const value = attempt.kind === 'fix' ? 'FIXED' : 'BROKEN';
              const code = writer
                ? `import pathlib,subprocess\nr='${target}'\npathlib.Path(r+'/criterion.txt').write_text('${value}\\n')\nsubprocess.check_call(['git','-C',r,'add','criterion.txt'])\nsubprocess.check_call(['git','-C',r,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','${value}'])`
                : `import pathlib\nassert pathlib.Path('${target}/criterion.txt').read_text() == '${attempt.kind === 'delta' ? 'FIXED' : 'BROKEN'}\\n'`;
              await copyCommand([
                'exec',
                '--user',
                'sandbox',
                sandbox.sandboxName,
                ...controlledAttemptArgv('run', execution.claimToken, writer ? 'write' : 'read', [
                  '/usr/bin/python3',
                  '-I',
                  '-B',
                  '-c',
                  code,
                ]),
              ]);
              let content = 'Physical committed writer';
              if (!writer)
                content = JSON.stringify({
                  findings:
                    attempt.kind === 'review'
                      ? [
                          {
                            criterion: 'criterion.txt contains FIXED',
                            summary: 'Marker is BROKEN',
                            location: 'criterion.txt:1',
                            evidenceRefs: [
                              `artifact-seal:${reviews.getApplicationPreparation('workflow', attempt.attemptId)!.seal.fenceId}`,
                            ],
                          },
                        ]
                      : [],
                  resolvedFingerprints:
                    attempt.kind === 'delta'
                      ? reviews.get('workflow')!.findings.map((f) => f.fingerprint)
                      : [],
                });
              onEvent?.({
                type: 'stream_event',
                event: { type: 'message_start', message: { id: turn } },
              });
              onEvent?.({
                type: 'stream_event',
                event: {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: content },
                },
              });
              onEvent?.({ type: 'result', usage_status: 'unknown' });
              registry.observations.terminal({
                claimToken: execution.claimToken,
                providerThreadId: thread,
                providerTurnId: turn,
                status: 'completed',
              });
              await registry.recover(execution.claimToken);
              return { providerThreadId: thread, content };
            },
            cancel: async () => registry.recover(execution.claimToken),
          }),
        });
        return retained;
      };
      const sealer = new PhysicalArtifactSealer({
        store: events,
        leaseHost,
        gateway: gateway as unknown as Parameters<typeof withOwnedArtifactSuccessor>[0]['gateway'],
        attemptRegistry: registry,
        runtimeConfig,
      });
      const successorDeps = {
        authority,
        gateway: gateway as unknown as Parameters<typeof withOwnedArtifactSuccessor>[0]['gateway'],
        leaseHost,
        sessionArtifacts: artifacts,
        sealer,
        sourceOwner: owner,
        sourceProof: {
          assertNoNativeClaims: () => {
            if (registry.hasSessionClaims(sessionId))
              throw Error('Source native claims already exist');
          },
          command: sealCommand,
        },
      };
      const composed: ReturnType<typeof createSymposiumProductionReviewComposition> =
        createSymposiumProductionReviewComposition({
          host: {
            gateway,
            sourceImport: {
              requireSeal: () => requireCompletedImportedSourceSeal(artifacts, owner, sessionId),
              initialExport: (_id: string, operationId: string) =>
                initialSourceExportReceipt(retainedSource, operationId),
            },
            sealSessionArtifacts: async (
              input: Parameters<PhysicalArtifactSealer['seal']>[0],
              selected: Parameters<PhysicalArtifactSealer['seal']>[1],
              signal: AbortSignal,
            ) => {
              const seal = await sealer.seal(input, selected, signal);
              if (dispatches === 1 && losePhysicalSealResponse) {
                losePhysicalSealResponse = false;
                throw Error('Injected lost physical seal response');
              }
              return seal;
            },
            requireCompletedArtifactSeal: async (fence: string, signal: AbortSignal) => {
              const seal = await sealer.requireCompleted(fence, signal);
              if (loseSealVerificationResponse) {
                loseSealVerificationResponse = false;
                throw Error('Injected lost completed-seal response');
              }
              return seal;
            },
            inspectCompletedArtifact: (
              input: Parameters<PhysicalArtifactSealer['inspectCompletedArtifact']>[0],
              signal: AbortSignal,
            ) => sealer.inspectCompletedArtifact(input, signal),
            exportCompletedReviewContext: (
              input: Parameters<PhysicalArtifactSealer['exportCompletedReviewContext']>[0],
              signal: AbortSignal,
            ) => sealer.exportCompletedReviewContext(input, signal),
            releaseCompletedReviewStream: (
              input: Parameters<PhysicalArtifactSealer['releaseCompletedReviewStream']>[0],
            ) => sealer.releaseCompletedReviewStream(input),
            releaseReadyReviewStream: (
              input: Parameters<PhysicalArtifactSealer['releaseReadyReviewStream']>[0],
            ) => sealer.releaseReadyReviewStream(input),
            releaseStoppedReadyReviewStream: (
              input: Parameters<PhysicalArtifactSealer['releaseStoppedReadyReviewStream']>[0],
            ) => sealer.releaseStoppedReadyReviewStream(input),
            trackApplicationTransition: <T>(operation: () => Promise<T>) => operation(),
            exportSuccessorArtifactBundle: (
              input: Parameters<PhysicalArtifactSealer['exportSuccessorArtifactBundle']>[0],
              signal: AbortSignal,
            ) => sealer.exportSuccessorArtifactBundle(input, signal),
            copySuccessorArtifact: async (
              request: Parameters<typeof withOwnedArtifactSuccessor>[1],
              receipt: Parameters<typeof withOwnedArtifactSuccessor>[2],
              bundle: Buffer,
              signal: AbortSignal,
            ) => {
              const copied = await withOwnedArtifactSuccessor(
                successorDeps,
                request,
                receipt,
                bundle,
                (copier) => copier.copy(request, receipt, bundle, signal),
              );
              volumes.push(copied.volumeName);
              return copied;
            },
            admitSuccessorArtifact: (
              request: Parameters<typeof withOwnedArtifactSuccessor>[1],
              binding: Parameters<typeof confirmOwnedArtifactSuccessor>[2],
              receipt: Parameters<typeof withOwnedArtifactSuccessor>[2],
              bundle: Buffer,
            ) =>
              withOwnedArtifactSuccessor(
                successorDeps,
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
                      () => true,
                    ),
                  ),
              ),
            inspectStoppedSuccessorOperation: (
              selected: Parameters<typeof inspectStoppedSuccessorOperation>[1],
            ) => inspectStoppedSuccessorOperation(leaseHost.snapshotDatabasePath(), selected),
            assertArtifactAdmissionCurrent: (
              id: string,
              ref: Parameters<EventStore['assertSymposiumArtifactAdmissionCurrent']>[1],
            ) => events.assertSymposiumArtifactAdmissionCurrent(id, ref),
            artifactLeaseHost: leaseHost,
            attemptRegistry: registry,
            currentProfiles: () => profiles,
            criterionChecks: [
              {
                id: 'marker',
                criterion: 'criterion.txt contains FIXED',
                version: 1,
                kind: 'file-sha256',
                path: 'criterion.txt',
                expectedSha256: createHash('sha256').update('FIXED\n').digest('hex'),
              },
            ],
            checkCompletedArtifactFile: (
              input: Parameters<PhysicalArtifactSealer['checkCompletedArtifactFile']>[0],
              signal: AbortSignal,
            ) => sealer.checkCompletedArtifactFile(input, signal),
          } as unknown as Parameters<typeof createSymposiumProductionReviewComposition>[0]['host'],
          events,
          reviews,
          grants: grants as unknown as Parameters<
            typeof createSymposiumProductionReviewComposition
          >[0]['grants'],
          actionAuthority,
          artifactResultsPath: applicationDatabase,
          runtime: () => getRuntime().orchestrator,
          retainedRuntime: () =>
            retained ? { orchestrator: retained.orchestrator, runtime: retained } : null,
          retireSealedRuntime: (_id, selected) => {
            expect(selected).toBe(retained);
            retained = null;
            if (dispatches === 2 && loseReaderRetirementResponse) {
              loseReaderRetirementResponse = false;
              injectedReaderFaults.push(
                'original reader retirement callback response lost after eviction',
              );
              throw Error('Injected lost original reader retirement response');
            }
          },
        });
      const context = { owner: 'user', sessionId };
      const coordinator = new SymposiumReviewCoordinator(reviews, composed.reviewHost);
      try {
        coordinator.startApplicationRun(context, {
          workflowId: 'workflow',
          acceptanceCriteria: ['criterion.txt contains FIXED'],
          limits: {
            version: 1,
            mode: 'application',
            maxHostTurns: 12,
            maxReviewCycles: 2,
            deadlineAt: Date.now() + 900_000,
            noProgressLimit: 2,
          },
          expectedArtifactRevision: retainedSource.receipt.git.commit,
          expectedArtifactHash: retainedSource.receipt.git.committedTreeDigest,
        });
        const run = async (kind: 'initial' | 'review' | 'fix', id: string) => {
          const reservation = await coordinator.reserveWithTransition(
            context,
            'workflow',
            kind,
            id,
          );
          expect(reservation).toMatchObject({ kind: 'reserved_not_dispatched' });
          let selected = reservation;
          expect(coordinator.recoverBoundTransition(context, 'workflow', kind, id)).toMatchObject({
            kind: 'reserved_not_dispatched',
          });
          if (id === 'initial') {
            const stopped = await coordinator.stop(context, 'workflow');
            expect(stopped.decisionCode).toBe('user_stop');
            expect(dispatches).toBe(0);
            expect(registry.pending()).toEqual([]);
            expect(containers.size).toBe(0);
            actionAuthority.bind(context, 'continue', () => {});
            if (stopped.limits.mode !== 'application') throw Error('Application limits required');
            const continued = coordinator.continue(
              context,
              'workflow',
              stopped.limits,
              'Resume exact cancelled-before-dispatch actor',
            );
            expect(continued).toMatchObject({ status: 'awaiting_initial' });
            selected = coordinator.recoverBoundTransition(context, 'workflow', kind, id);
            expect(selected).toMatchObject({ kind: 'reserved_not_dispatched', attemptId: id });
          }
          if (selected.kind !== 'reserved_not_dispatched')
            throw Error('Exact dispatch reservation required');
          await composed.reviewHost.dispatch(context, selected);
          expect(coordinator.recoverBoundTransition(context, 'workflow', kind, id)).toMatchObject({
            kind: 'decision_required',
            code: 'attempt_already_dispatched',
          });
          return selected;
        };
        await expect(run('initial', 'initial')).rejects.toThrow(
          'Symposium seat cleanup incomplete',
        );
        const writerMember = events.getLatestSymposiumMembership(sessionId, 'coder')!;
        const writerReference = events.getSymposiumArtifactReference(
          sessionId,
          'coder',
          writerMember.generation,
        )!;
        if ('kind' in writerReference) throw Error('Original writer reference required');
        const originalSeal = events.getSymposiumArtifactSealIntent(
          sessionId,
          writerReference.artifactGenerationId,
        )!;
        const pendingSealJob = () => {
          const db = new Database(database, { readonly: true });
          try {
            return db
              .prepare(
                'SELECT fence_id,phase,verifier_id,receipt_json FROM symposium_physical_seal_jobs',
              )
              .all();
          } finally {
            db.close();
          }
        };
        expect(pendingSealJob()).toEqual([
          {
            fence_id: originalSeal.fenceId,
            phase: 'draining',
            verifier_id: null,
            receipt_json: null,
          },
        ]);
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Injected lost pre-verifier census response',
        );
        expect(pendingSealJob()).toEqual([
          {
            fence_id: originalSeal.fenceId,
            phase: 'draining',
            verifier_id: null,
            receipt_json: null,
          },
        ]);
        expect(retained).not.toBeNull();
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Injected lost physical seal response',
        );
        expect(
          events.getSymposiumArtifactSealIntent(sessionId, writerReference.artifactGenerationId)
            ?.fenceId,
        ).toBe(originalSeal.fenceId);
        expect(pendingSealJob()).toMatchObject([
          { fence_id: originalSeal.fenceId, phase: 'complete' },
        ]);
        expect(dispatches).toBe(1);
        expect(retained).not.toBeNull();
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Injected lost completed-seal response',
        );
        await composed.reviewHost.refreshArtifact!(context);
        expect(retained).toBeNull();
        await composed.reviewHost.refreshArtifact!(context);
        expect(dispatches).toBe(1);
        expect(
          coordinator.recoverBoundTransition(context, 'workflow', 'initial', 'initial'),
        ).toMatchObject({ kind: 'decision_required', code: 'attempt_already_dispatched' });
        expect(composed.reviewHost.receipt(context, 'initial')).toEqual(
          composed.reviewHost.receipt(context, 'initial'),
        );
        expect(composed.reviewHost.receipt(context, 'initial')).toMatchObject({
          terminal: true,
          costUsd: null,
        });
        expect(coordinator.recordInitialResult(context, 'workflow', 'initial')).toMatchObject({
          status: 'awaiting_review',
        });
        await expect(run('review', 'review')).rejects.toThrow('Symposium seat cleanup incomplete');
        expect(dispatches).toBe(2);
        expect(retained).not.toBeNull();
        const readerRuntimeCreations = runtimeCreations;
        await expect(composed.reviewHost.refreshArtifact!(context)).rejects.toThrow(
          'Injected lost original reader retirement response',
        );
        expect(retained).toBeNull();
        await composed.reviewHost.refreshArtifact!(context);
        expect(retained).toBeNull();
        expect(runtimeCreations).toBe(readerRuntimeCreations);
        expect(dispatches).toBe(2);
        expect(
          coordinator.recoverBoundTransition(context, 'workflow', 'review', 'review'),
        ).toMatchObject({ kind: 'decision_required', code: 'attempt_already_dispatched' });

        const reviewed = composed.reviewHost.completedReview!(context, 'review')!;
        expect(
          coordinator.recordReview(context, {
            workflowId: 'workflow',
            attemptId: 'review',
            reviewId: reviewed.reviewId,
          }),
        ).toMatchObject({ status: 'awaiting_fix' });
        actionAuthority.bind(context, 'fix', () => {});
        expect(
          coordinator.authorizeFix(context, {
            workflowId: 'workflow',
            findingFingerprints: reviews.get('workflow')!.findings.map((f) => f.fingerprint),
            reason: 'Fix marker',
          }),
        ).toMatchObject({ status: 'awaiting_fix' });
        await run('fix', 'fix');
        expect(coordinator.recordFix(context, 'workflow', 'fix')).toMatchObject({
          status: 'awaiting_delta_review',
        });
        await run('review', 'delta');
        const delta = composed.reviewHost.completedReview!(context, 'delta')!;
        coordinator.recordReview(context, {
          workflowId: 'workflow',
          attemptId: 'delta',
          reviewId: delta.reviewId,
        });
        const evidence = await composed.reviewHost.runCriterionCheck!(
          context,
          'workflow',
          'marker',
        );
        expect(await composed.reviewHost.runCriterionCheck!(context, 'workflow', 'marker')).toEqual(
          evidence,
        );
        coordinator.recordHostEvidence(context, 'workflow', evidence.evidenceId);
        const exported = coordinator.exportRecord(context, 'workflow');
        expect(exported).toMatchObject({ kind: 'verified' });
        if (exported.kind !== 'verified') throw Error('Exact immutable verified record required');
        const record = exported.record;
        const publicationSignal = new AbortController().signal;
        const publicationArtifact = completedPublicationArtifact({
          store: reviews,
          host: {
            requireCompletedArtifactSeal: (fence, signal) => sealer.requireCompleted(fence, signal),
            inspectCompletedArtifact: (input, signal) =>
              sealer.inspectCompletedArtifact(input, signal),
            exportCompletedArtifactBundle: (input, signal) =>
              sealer.exportCompletedArtifactBundle(input, signal),
          },
        });
        const finalSeal = await sealer.requireCompleted(
          publicationSealFenceForRecord(record),
          publicationSignal,
        );
        const scope = {
          operatorId: 'fixture-operator',
          sessionId,
          recordId: record.recordId,
          recordHash: record.contentHash,
          sealId: finalSeal.fenceId,
          sealHash: completedSealHash(finalSeal),
          repository: 'example/project',
          connectionId: 'offline-publication',
          connectionRevision: 1,
          credentialGeneration: 'synthetic-publication-generation',
        };
        // This transport is a synthetic remote-read boundary. It rejects every
        // write/network command; real authority, operation and artifact owners remain.
        const remoteReads = vi.fn(async (command: string, args: readonly string[]) => {
          if (command !== 'gh' || args[0] !== 'api' || !args.includes('GET'))
            throw Error('External publication forbidden');
          const endpoint = args.find((arg) => arg === '/user' || arg.startsWith('repos/'));
          const value =
            endpoint === '/user'
              ? { id: 42, login: 'offline-user', type: 'User' }
              : endpoint === 'repos/example/project'
                ? { full_name: 'example/project', default_branch: 'main' }
                : endpoint?.includes('/rules/branches/') || endpoint?.endsWith('/pulls')
                  ? []
                  : endpoint?.includes('/branches/')
                    ? { protected: false, commit: { sha: finalSeal.git.commit } }
                    : undefined;
          if (value === undefined) throw Error('Unexpected synthetic publication read');
          return { stdout: JSON.stringify(value) };
        });
        const handle: PublicationCredentialHandle = {
          connectionId: scope.connectionId,
          revision: 1,
          generation: scope.credentialGeneration,
          assertCurrent: () => true,
          run: remoteReads,
        };
        const publicationAuthority = new SealedPublicationAuthority(
          join(root, 'publication-authority.db'),
          {
            assertOperator: (id) => {
              if (id !== scope.operatorId) throw Error('Unknown fixture operator');
              return true;
            },
            assertArtifact: async (selected, signal) => {
              await publicationArtifact.require(selected, signal);
            },
            resolveCredential: () => handle,
          },
        );
        const publicationOperations = new CapabilityOperationStore(
          join(root, 'publication-operations.db'),
        );
        try {
          const grant = await publicationAuthority.grant(
            scope,
            { host: 'github.com', numericId: 42, login: 'offline-user' },
            publicationSignal,
          );
          const publication = new SealedPublicationService({
            authority: publicationAuthority,
            operations: publicationOperations,
            artifact: publicationArtifact,
            credentialCustodianRegistered: true,
          });
          const input = {
            grantId: grant.id,
            bindingHash: grant.bindingHash,
            turnId: 'publication-preparation',
            idempotencyKey: 'publication-preparation',
            publication: {
              repositoryPath: target,
              baseBranch: 'main',
              title: 'Offline preparation',
              body: `Review record: ${record.recordId}\nSHA256: ${record.contentHash}`,
              draft: true,
            },
          };
          const approval = vi.fn(async () => false);
          const prepared = await publication.invoke(input, publicationSignal, approval);
          expect(prepared.status).toBe('denied');
          expect(approval).toHaveBeenCalledOnce();
          const reads = remoteReads.mock.calls.length;
          expect(await publication.invoke(input, publicationSignal, approval)).toEqual(prepared);
          expect(
            remoteReads.mock.calls.slice(reads).every(([, args]) => args.includes('/user')),
          ).toBe(true);
          expect(approval).toHaveBeenCalledOnce();
        } finally {
          publicationAuthority.close();
          publicationOperations.close();
        }

        expect(dispatches).toBe(4);
        expect(registry.pending()).toEqual([]);
        expect(registry.pendingPreparations()).toEqual([]);
        expect(reviews.get('workflow')).toMatchObject({
          hostTurns: 4,
          usageCompleteness: { tokens: 'partial', cost: 'partial' },
        });
        expect(reviews.get('workflow')!.reviewCycles).toBeLessThanOrEqual(2);
        expect(retained).toBeNull();
        retained = null;
        for (const [name, id] of containers)
          expect(await inspect(name), `Exact retired container ${id}`).toBeUndefined();
        for (const volume of [...new Set(volumes)]) {
          expect(
            JSON.parse(
              await copyCommand([
                'ps',
                '--all',
                '--no-trunc',
                '--filter',
                `volume=${volume}`,
                '--format',
                'json',
              ]),
            ),
          ).toEqual([]);
        }
        writeFileSync(
          join(root, 'retained.json'),
          JSON.stringify(
            {
              volumes,
              helpers,
              containers: [...containers],
              completed: true,
              disposition: 'preserved physical artifact evidence; no mounted resources',
            },
            null,
            2,
          ),
        );
        expect(sourceReceipt()).toEqual(sourceBefore);
        expect({
          commit: git('rev-parse', 'HEAD'),
          tree: git('rev-parse', 'HEAD^{tree}'),
          config: readFileSync(join(repo, '.git/config'), 'utf8'),
          status: git('status', '--porcelain'),
        }).toEqual(selectedBefore);
        completed = true;
        writeFileSync(
          join(root, 'evidence.json'),
          JSON.stringify(
            {
              modelCalls: 0,
              dispatches,
              completed,
              sourceBefore,
              selectedBefore,
              workflow: reviews.get('workflow'),
              recordHash: record.contentHash,
              injectedSealFaults,
              injectedReaderFaults,
              runtimeCreations,
              originalSealFenceId: originalSeal.fenceId,
              synthetic: [
                'source session facts for disposable draft import',
                'gateway identity and provider/account/grant attestation',
                'manager lifecycle transport',
                'deterministic model transport and native provider events',
                'publication operator/credential attestation, GitHub identity/repository metadata GET transport',
              ],
              real: [
                'source import/seal',
                'successor copy/admission',
                'claim/permit',
                'controller',
                'reader admission',
                'runtime retirement',
                'criterion file hash',
                'immutable record',
                'sealed publication preparation',
              ],
              cancellation:
                'exact staged actor stopped before dispatch then original epoch resumed',
              publication:
                'forced approval denied; no external writes; legacy live-writer adapter unexercised',
              semanticCriteria: false,
            },
            null,
            2,
          ),
        );
      } finally {
        composed.close();
        sealer.close();
        registry.close();
        events.close();
        reviews.close();
        leaseHost.close();
        vi.restoreAllMocks();
      }
    } finally {
      artifacts.close();
      if (!completed) {
        writeFileSync(
          join(root, 'retained.json'),
          JSON.stringify({ volumes, helpers, completed: false }, null, 2),
        );
        console.error(`Retained application fixture: ${root}`);
      }
    }
  },
  900_000,
);
