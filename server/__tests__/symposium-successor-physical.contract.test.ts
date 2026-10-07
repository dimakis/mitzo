/** Opt-in credential-free exporter → owned copier → physical fix/reviewer → SQLite record.
 * Seal/custody, interactive fix authority, native results and reviewer output are
 * isolated fixtures, not a completed live application run. */
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME as runtime } from '../symposium-owned-runtime-contract.js';
import { SYMPOSIUM_ARTIFACT_TARGET as target } from '../symposium-artifact-lease.js';
import { SymposiumSessionArtifacts } from '../symposium-session-artifacts.js';
import { createArtifactGitVolume, artifactGitContract } from '../symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
import {
  ArtifactPodmanContext,
  SqliteArtifactLeaseHost,
  volumeEvidence,
} from '../symposium-artifact-host.js';
import {
  PhysicalArtifactSealer,
  type CompletedArtifactSeal,
} from '../symposium-physical-artifact-seal.js';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';
import { withOwnedArtifactSuccessor } from '../symposium-owned-successor.js';
import { successorCopierContract } from '../symposium-artifact-successor-copy.js';
import { canonicalReviewJson, reviewRecordHash } from '../symposium-review-records.js';
import { ARTIFACT_GIT_EXPORT } from '../symposium-artifact-git-export.js';
import { SymposiumReviewCoordinator } from '../symposium-review-coordinator.js';
import type { ArtifactGenerationRequest } from '../symposium-artifact-generations.js';
const digest = (v: unknown) => reviewRecordHash(canonicalReviewJson(v));
const physical = process.env.MITZO_SUCCESSOR_PHYSICAL_CONTRACT === '1';
it.skipIf(!physical)(
  'copies a sealed parent, commits a fix, checks from read-only review, and exports the durable record',
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
    const root = mkdtempSync(join(tmpdir(), 'mitzo-successor-contract-'));
    const sessionId = randomUUID(),
      workspace = 'successor-contract';
    const custodyDigest = createHash('sha256').update(root).digest('hex');
    const env = { HOME: process.env.HOME, PATH: process.env.PATH };
    const command = async (
      args: readonly string[],
      maxOutputBytes = 2 * 1024 * 1024,
      input?: Buffer,
    ) =>
      execFileSync(process.env.MITZO_CONTRACT_PODMAN ?? 'podman', [...args], {
        env,
        input,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: maxOutputBytes,
      });
    const helpers: string[] = [],
      volumes: string[] = [];
    const signal = new AbortController().signal;
    const gateway = {
      workspace,
      stateDirectory: root,
      verifyCustody() {},
      async verifyCustodyAsync() {},
    };
    const leaseHost = new SqliteArtifactLeaseHost(
      join(root, 'custody.db'),
      { verifyGateway: async () => {}, verifyMount: async () => {}, verifyDeleted: async () => {} },
      new ArtifactPodmanContext(command),
      gateway as never,
    );
    const owner = symposiumArtifactOwner(runtime.build.image);
    const sessionArtifacts = new SymposiumSessionArtifacts(
      join(root, 'custody.db'),
      workspace,
      root,
      () => {},
      {
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
      },
    );
    const reviews = new SymposiumReviewStore(join(root, 'reviews.db'));
    let sealer: PhysicalArtifactSealer | undefined;
    let completed = false;
    try {
      expect(await sessionArtifacts.ensure(sessionId)).toEqual({ state: 'ready' });
      const mapping = sessionArtifacts.getReady(sessionId)!;
      const helper = async (
        volume: string,
        readonly: boolean,
        code: string,
        args: string[] = [],
      ) => {
        const id = (
          await command([
            'create',
            '--pull=never',
            '--name',
            `mitzo-successor-fixture-${randomUUID()}`,
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=32',
            '--memory=256m',
            '--timeout=30',
            '--user',
            '998:998',
            '--mount',
            `type=volume,src=${volume},dst=${target}${readonly ? ',readonly' : ''}`,
            '--entrypoint=/usr/bin/python3',
            runtime.build.image,
            '-I',
            '-B',
            '-c',
            code,
            ...args,
          ])
        ).trim();
        expect(id).toMatch(/^[a-f0-9]{64}$/);
        helpers.push(id);
        const output = await command(['start', '--attach', id]);
        const [state] = JSON.parse(await command(['inspect', id]));
        expect(state.State).toMatchObject({ Running: false, ExitCode: 0 });
        await command(['rm', id]);
        return output;
      };
      await helper(
        mapping.volumeName,
        false,
        `import subprocess,pathlib\nr='${target}'\ndef git(*args): return subprocess.check_output(['git','-C',r,'-c','user.name=Contract','-c','user.email=contract@example.invalid','-c','commit.gpgsign=false',*args])\npathlib.Path(r+'/base.txt').write_text('BASE')\ngit('add','.')\ngit('commit','-qm','base')\ngit('update-ref','refs/remotes/origin/main','HEAD')\ngit('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main')\ngit('config','remote.origin.url','https://github.com/example/repo')\ngit('checkout','-qb','feature')\npathlib.Path(r+'/feature.txt').write_text('PARENT')\ngit('add','.')\ngit('commit','-qm','feature')\n`,
      );
      const git = JSON.parse(await helper(mapping.volumeName, true, ARTIFACT_GIT_VERIFIER, ['.']));
      const seal: CompletedArtifactSeal = {
        kind: 'completed_artifact_seal',
        version: 1,
        fenceId: randomUUID(),
        sessionId,
        custodyDigest,
        intentDigest: 'a'.repeat(64),
        retentionDigest: 'b'.repeat(64),
        revocationDigest: 'c'.repeat(64),
        repositoryPath: '.',
        git,
        verifier: {
          id: helpers.at(-1)!,
          image: runtime.build.image,
          codeDigest: createHash('sha256').update(ARTIFACT_GIT_VERIFIER).digest('hex'),
        },
        completedAt: Date.now(),
      };
      const intent = {
        selection: {
          artifact: { volumeName: mapping.volumeName, volumeGeneration: mapping.volumeGeneration },
        },
      };
      // Only the prior seal/revocation fixture is substituted. All exporter receipt,
      // physical copy, verification, cleanup and generation transitions below are production code.
      class FixtureSealer extends PhysicalArtifactSealer {
        override async requireCompleted() {
          const rows = JSON.parse(
            await command([
              'ps',
              '--all',
              '--no-trunc',
              '--filter',
              `volume=${mapping.volumeName}`,
              '--format',
              'json',
            ]),
          );
          for (const row of rows) {
            const [detail] = JSON.parse(await command(['inspect', row.Id ?? row.ID]));
            if (detail.Mounts.some((m: { Name?: string }) => m.Name === mapping.volumeName))
              throw new Error('Fixture parent has an active mount');
          }
          return structuredClone(seal);
        }
      }
      sealer = new FixtureSealer({
        store: {
          getSymposiumArtifactSealIntent: () => intent,
          getSymposiumArtifactSealByFence: (fenceId: string) =>
            fenceId === seal.fenceId ? intent : null,
          withSymposiumArtifactSealSnapshot: (_value: unknown, run: () => void) => run(),
        } as never,
        leaseHost,
        gateway: gateway as never,
        attemptRegistry: {} as never,
        runtimeConfig: {} as never,
      });
      const exported = await sealer.exportSuccessorArtifactBundle(
        {
          fenceId: seal.fenceId,
          operationId: 'physical-copy',
          sourceBranch: 'feature',
          baseBranch: 'main',
          sourceOid: git.commit,
          maxBytes: 8 * 1024 * 1024,
        },
        signal,
      );
      const selection = (seatId: string, role: string) => ({
        seatId,
        role,
        selectionId: seatId,
        policyRevision: '1',
        profileId: role,
        profileRevision: 1,
        accountId: `${seatId}-account`,
        model: 'luna-fixture-no-calls',
      });
      reviews.create({
        workflowId: 'workflow',
        owner: 'fixture-owner',
        sessionId,
        implementation: {
          version: 1,
          resultId: 'result',
          attemptId: 'implementation',
          inputRevision: 'input',
          inputHash: 'a'.repeat(64),
          artifactRevision: git.commit,
          artifactHash: git.committedTreeDigest,
          summary: 'Physical fixture',
          evidenceRefs: ['fixture'],
          completedAt: 1,
        },
        implementer: selection('writer', 'coder'),
        reviewer: selection('reviewer', 'reviewer'),
        acceptanceCriteria: ['fixture criterion'],
        limits: { maxReviewRounds: 2, maxTokens: 1000, maxCostUsd: 1 },
      });
      reviews.admitAttempt({
        workflowId: 'workflow',
        attemptId: 'review',
        enforcementId: 'fixture-only-no-provider',
        kind: 'review',
        actorSeatId: 'reviewer',
        artifactRevision: git.commit,
        artifactHash: git.committedTreeDigest,
        maxTokens: 1,
        maxCostUsd: 0,
      });
      const reviewed = reviews.recordReview({
        workflowId: 'workflow',
        reviewId: 'review',
        reviewerSeatId: 'reviewer',
        kind: 'full',
        artifactRevision: git.commit,
        artifactHash: git.committedTreeDigest,
        findings: [
          {
            criterion: 'fixture criterion',
            summary: 'Fixture finding',
            location: 'feature.txt',
            evidenceRefs: ['fixture'],
          },
        ],
        resolvedFingerprints: [],
        usage: { attemptId: 'review', tokens: 0, costUsd: 0 },
      });
      const findingFingerprints = reviewed.findings.map((f) => f.fingerprint);
      reviews.authorizeFix({
        workflowId: 'workflow',
        artifactRevision: git.commit,
        artifactHash: git.committedTreeDigest,
        actor: 'fixture-owner',
        authorityGrantId: 'fixture-grant',
        authorityRevision: 1,
        findingFingerprints,
        reason: 'disposable physical fixture',
      });
      reviews.admitAttempt({
        workflowId: 'workflow',
        attemptId: 'fix',
        enforcementId: 'fixture-only-no-provider',
        kind: 'fix',
        actorSeatId: 'writer',
        artifactRevision: git.commit,
        artifactHash: git.committedTreeDigest,
        maxTokens: 1,
        maxCostUsd: 0,
      });
      const request: ArtifactGenerationRequest = {
        sessionId,
        workspace,
        custodyDigest,
        operationId: 'physical-copy',
        expectedPointerRevision: 0,
        parentGenerationId: mapping.volumeGeneration,
        parentSealDigest: exported.receipt.parentSealDigest,
        parentCommit: git.commit,
        parentTree: git.tree,
        parentManifestDigest: git.manifestDigest,
        parentCommittedTreeDigest: git.committedTreeDigest,
        bundleSha256: exported.receipt.bundleSha256,
        exportReceiptDigest: digest(exported.receipt),
        workflowId: 'workflow',
        fixAttemptId: 'fix',
        actor: 'fixture-owner',
        authorityGrantId: 'fixture-grant',
        authorityRevision: 1,
        seatId: 'writer',
        membershipGeneration: 1,
        accountId: 'writer-account',
        model: 'luna-fixture-no-calls',
        profileId: 'coder',
        profileRevision: '1',
        findingFingerprints,
        ...successorCopierContract(),
      };
      let currentAuthority = true;
      const deps = {
        authority: {
          workflows: reviews,
          assertCurrent: () => {
            if (!currentAuthority) throw new Error('fixture authority revoked');
            return true as const;
          },
        },
        gateway: gateway as never,
        leaseHost,
        sessionArtifacts,
        sealer,
        sourceOwner: owner,
        sourceProof: { assertNoNativeClaims: () => {}, command },
      };
      const copied = await withOwnedArtifactSuccessor(
        deps,
        request,
        exported.receipt,
        exported.bundle,
        (copier) => copier.copy(request, exported.receipt, exported.bundle, signal),
      );
      volumes.push(copied.volumeName);
      const db = new Database(join(root, 'custody.db'));
      expect(
        db.prepare('SELECT generation_id FROM symposium_artifact_generation_heads').get(),
      ).toEqual({ generation_id: mapping.volumeGeneration });
      expect(
        JSON.parse(await helper(copied.volumeName, true, ARTIFACT_GIT_VERIFIER, ['.'])),
      ).toEqual(git);
      currentAuthority = false;
      await expect(
        withOwnedArtifactSuccessor(deps, request, exported.receipt, exported.bundle, (copier) =>
          copier.activate(request, copied.generationId, exported.receipt, exported.bundle, signal),
        ),
      ).rejects.toThrow('revoked');
      currentAuthority = true;
      expect(await sessionArtifacts.ensure(sessionId)).toEqual({ state: 'ready' });
      await withOwnedArtifactSuccessor(deps, request, exported.receipt, exported.bundle, (copier) =>
        copier.activate(request, copied.generationId, exported.receipt, exported.bundle, signal),
      );
      expect(
        db.prepare('SELECT generation_id,revision FROM symposium_artifact_generation_heads').get(),
      ).toEqual({ generation_id: copied.generationId, revision: 1 });
      expect(
        JSON.parse(await helper(mapping.volumeName, true, ARTIFACT_GIT_VERIFIER, ['.'])),
      ).toEqual(git);
      // The native writer and reviewer below are credential-free physical stand-ins.
      // Their results are fed to the real durable workflow, not presented as a live provider run.
      await helper(
        copied.volumeName,
        false,
        `import subprocess,pathlib\nr='${target}'\np=pathlib.Path(r+'/feature.txt')\np.write_text('FIXED\\n')\nsubprocess.check_call(['git','-C',r,'add','feature.txt'])\nsubprocess.check_call(['git','-C',r,'-c','user.name=Contract','-c','user.email=contract@example.invalid','-c','commit.gpgsign=false','commit','-qm','fix'])\n`,
      );
      const fixed = JSON.parse(await helper(copied.volumeName, true, ARTIFACT_GIT_VERIFIER, ['.']));
      expect(fixed.commit).not.toBe(git.commit);
      expect(fixed.committedTreeDigest).not.toBe(git.committedTreeDigest);
      const checked = JSON.parse(
        await helper(copied.volumeName, true, ARTIFACT_GIT_EXPORT, [
          '.',
          JSON.stringify({ kind: 'check', checkPath: 'feature.txt', expected: fixed }),
        ]),
      );
      const expectedFileHash = createHash('sha256').update('FIXED\n').digest('hex');
      expect(checked).toMatchObject({ proof: fixed, observedSha256: expectedFileHash });
      const fixResult = {
        version: 1 as const,
        resultId: 'physical-fix-fixture',
        attemptId: 'fix',
        inputRevision: git.commit,
        inputHash: git.committedTreeDigest,
        artifactRevision: fixed.commit,
        artifactHash: fixed.committedTreeDigest,
        summary: 'Credential-free physical writer fixture',
        evidenceRefs: ['physical-child-git-commit'],
        completedAt: Date.now(),
      };
      expect(
        reviews.recordFix({
          workflowId: 'workflow',
          implementerSeatId: 'writer',
          result: fixResult,
          usage: { attemptId: 'fix', tokens: 0, costUsd: 0 },
        }),
      ).toMatchObject({ status: 'awaiting_delta_review' });
      reviews.admitAttempt({
        workflowId: 'workflow',
        attemptId: 'delta',
        enforcementId: 'fixture-only-no-provider',
        kind: 'review',
        actorSeatId: 'reviewer',
        artifactRevision: fixed.commit,
        artifactHash: fixed.committedTreeDigest,
        maxTokens: 1,
        maxCostUsd: 0,
      });
      expect(
        reviews.recordReview({
          workflowId: 'workflow',
          reviewId: 'delta',
          reviewerSeatId: 'reviewer',
          kind: 'delta',
          artifactRevision: fixed.commit,
          artifactHash: fixed.committedTreeDigest,
          findings: [],
          resolvedFingerprints: findingFingerprints,
          usage: { attemptId: 'delta', tokens: 0, costUsd: 0 },
        }),
      ).toMatchObject({ status: 'awaiting_evidence' });
      const evidenceId = 'physical-criterion-fixture';
      const evidence = {
        version: 1 as const,
        evidenceId,
        resultId: fixResult.resultId,
        criterion: 'fixture criterion',
        verdict: 'verified' as const,
        artifactRevision: fixed.commit,
        evidenceRefs: [`podman-readonly:${checked.observedSha256}`],
        checkedAt: Date.now(),
      };
      expect(() =>
        reviews.recordEvidence(
          'workflow',
          { ...evidence, evidenceId: 'stale-parent-evidence', resultId: 'result' },
          fixed.committedTreeDigest,
          'host',
        ),
      ).toThrow(/stale result/i);
      reviews.recordEvidence('workflow', evidence, fixed.committedTreeDigest, 'host');
      const record = new SymposiumReviewCoordinator(reviews, {
        currentArtifact: () => ({ revision: fixed.commit, hash: fixed.committedTreeDigest }),
      } as never).exportRecord({ owner: 'fixture-owner', sessionId }, 'workflow');
      expect(record).toMatchObject({
        kind: 'verified',
        artifactRevision: fixed.commit,
        artifactHash: fixed.committedTreeDigest,
        record: { snapshot: { workflowId: 'workflow' } },
      });
      const reopened = new SymposiumReviewStore(join(root, 'reviews.db'));
      try {
        expect(reopened.get('workflow')).toMatchObject({
          status: 'verified',
          fixes: [{ attemptId: 'fix' }],
          findings: [{ status: 'fixed' }],
        });
        expect(reopened.finalize('workflow')).toMatchObject({ kind: 'verified' });
      } finally {
        reopened.close();
      }
      const retained = db
        .prepare(
          'SELECT generation_id,state,helper_id,physical_json,receipt_json FROM symposium_artifact_generations WHERE generation_id=?',
        )
        .get(copied.generationId);
      db.close();
      for (const volume of volumes) await command(['volume', 'rm', volume]);
      expect(sourceReceipt()).toEqual(sourceBefore);
      completed = true;
      writeFileSync(
        join(root, 'evidence.json'),
        JSON.stringify(
          {
            completed,
            sourceBefore,
            sourceAfter: sourceReceipt(),
            image: runtime.build.image,
            parent: mapping,
            seal,
            exportReceipt: exported.receipt,
            copied,
            fixed,
            checked,
            record,
            retained,
            exactFixtureHelpers: helpers,
            cleanupComplete: true,
            modelCalls: 0,
            applicationCredentials: false,
            simulatedBoundary:
              'prior seal/revocation, interactive fix authority, provider-native writer result and reviewer output; no application writer admission',
          },
          null,
          2,
        ),
      );
      console.log(`Physical successor evidence: ${root}/evidence.json`);
    } finally {
      sealer?.close();
      reviews.close();
      sessionArtifacts.close();
      leaseHost.close();
      if (!completed) {
        writeFileSync(
          join(root, 'retained.json'),
          JSON.stringify({ helpers, volumes, completed: false }, null, 2),
        );
        console.error(`Retained exact physical successor fixture: ${root}`);
      }
    }
  },
  360000,
);
