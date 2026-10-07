import { createHash } from 'node:crypto';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
import {
  SymposiumArtifactGenerations,
  type ArtifactGenerationRequest,
  type ArtifactGenerationIntent,
  type ArtifactGenerationCopyReceipt,
} from './symposium-artifact-generations.js';
import type {
  PhysicalArtifactSealer,
  SuccessorArtifactExportReceipt,
} from './symposium-physical-artifact-seal.js';
import type { InitialSourceExportReceipt } from './symposium-source-artifact-seal.js';
import { volumeEvidence, type ArtifactPodmanCommand } from './symposium-artifact-host.js';
import {
  artifactVolumeLabels,
  assertSessionArtifactVolume,
} from './symposium-session-artifacts.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from './symposium-owned-runtime-contract.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import { ARTIFACT_GIT_SUCCESSOR_IMPORT } from './symposium-artifact-git-successor-import.js';
const digest = (value: unknown) => reviewRecordHash(canonicalReviewJson(value));
const helperIdPattern = /^[a-f0-9]{64}$/;
const runtime = REVIEWED_SYMPOSIUM_OWNED_RUNTIME;
type ArtifactParentExport = SuccessorArtifactExportReceipt | InitialSourceExportReceipt;
export function successorCopierContract() {
  return {
    copierImageDigest: runtime.build.image.replace(/^sha256:/, ''),
    copierCodeDigest: createHash('sha256').update(ARTIFACT_GIT_SUCCESSOR_IMPORT).digest('hex'),
  };
}
/** Physical effects only; the existing ledger retains authority and pointer ownership.
 * Copy never admits a writer, clears a seal fence or retries uncertain work. */
export class PhysicalArtifactSuccessorCopier {
  constructor(
    private readonly deps: {
      ledger: SymposiumArtifactGenerations;
      sealer: Pick<
        PhysicalArtifactSealer,
        'requireSuccessorExport' | 'assertRetainedSuccessorExport'
      >;
      initialSource?: {
        assertRetainedInitialSourceExport(
          receipt: InitialSourceExportReceipt,
          bundle: Buffer,
        ): true;
        requireInitialSourceExport(
          receipt: InitialSourceExportReceipt,
          bundle: Buffer,
          signal: AbortSignal,
        ): Promise<unknown>;
      };
      command: ArtifactPodmanCommand;
      custody(): Promise<void>;
    },
  ) {}
  private match(request: ArtifactGenerationRequest, receipt: ArtifactParentExport, bundle: Buffer) {
    if (request.kind === 'initial') {
      if (
        receipt.mode !== 'initial' ||
        receipt.sourceSealId !== request.sourceSealId ||
        this.deps.initialSource?.assertRetainedInitialSourceExport(receipt, bundle) !== true
      )
        throw new Error('Retained initial source export proof required');
    } else {
      if (receipt.mode !== 'successor') throw new Error('Fix requires a writer seal export');
      this.deps.sealer.assertRetainedSuccessorExport(receipt, bundle);
    }
    const contract = successorCopierContract();
    if (
      request.operationId !== receipt.operationId ||
      request.sessionId !== receipt.seal.sessionId ||
      request.custodyDigest !== receipt.seal.custodyDigest ||
      request.parentGenerationId !== receipt.parentGenerationId ||
      request.parentSealDigest !== receipt.parentSealDigest ||
      request.exportReceiptDigest !== digest(receipt) ||
      request.bundleSha256 !== receipt.bundleSha256 ||
      request.parentCommit !== receipt.seal.git.commit ||
      request.parentTree !== receipt.seal.git.tree ||
      request.parentManifestDigest !== receipt.seal.git.manifestDigest ||
      request.parentCommittedTreeDigest !== receipt.seal.git.committedTreeDigest ||
      request.copierImageDigest !== contract.copierImageDigest ||
      request.copierCodeDigest !== contract.copierCodeDigest
    )
      throw new Error('Successor copy lineage or contract changed');
  }
  private async check(receipt: ArtifactParentExport, bundle: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.deps.custody();
    if (receipt.mode === 'initial') {
      if (!this.deps.initialSource) throw new Error('Retained initial source proof unavailable');
      await this.deps.initialSource.requireInitialSourceExport(receipt, bundle, signal);
    } else await this.deps.sealer.requireSuccessorExport(receipt, bundle, signal);
    signal.throwIfAborted();
  }
  private async volume(intent: ArtifactGenerationIntent) {
    const rows: unknown = JSON.parse(
      await this.deps.command(['volume', 'inspect', intent.volumeName]),
    );
    assertSessionArtifactVolume(
      intent.request.workspace,
      {
        sessionId: intent.request.sessionId,
        volumeName: intent.volumeName,
        volumeGeneration: intent.generationId,
      },
      volumeEvidence(rows, intent.volumeName),
    );
  }
  private async inspect(intent: ArtifactGenerationIntent, helperId: string) {
    const rows: unknown = JSON.parse(await this.deps.command(['inspect', helperId]));
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Successor helper unavailable');
    const row = rows[0];
    const mounts = row.Mounts;
    if (
      row.Id !== helperId ||
      row.ImageName !== runtime.build.image ||
      row.Config?.User !== `${runtime.workload.uid}:${runtime.workload.gid}` ||
      row.Config?.Labels?.['mitzo.artifact-generation'] !== intent.generationId ||
      row.HostConfig?.NetworkMode !== 'none' ||
      row.HostConfig?.ReadonlyRootfs !== true ||
      row.HostConfig?.Privileged !== false ||
      !Array.isArray(mounts) ||
      mounts.filter((m) => m.Type === 'volume').length !== 1 ||
      !mounts.some(
        (m) =>
          m.Type === 'volume' &&
          m.Name === intent.volumeName &&
          m.Destination === SYMPOSIUM_ARTIFACT_TARGET &&
          m.RW === true,
      ) ||
      mounts.some((m) => m.Type !== 'volume' && !(m.Type === 'tmpfs' && m.Destination === '/tmp'))
    )
      throw new Error('Successor helper isolation changed');
    return row as { State?: { Running?: boolean; ExitCode?: number } };
  }
  private async absent(intent: ArtifactGenerationIntent, helperId: string) {
    const rows: unknown = JSON.parse(
      await this.deps.command(['ps', '--all', '--no-trunc', '--format', 'json']),
    );
    if (
      !Array.isArray(rows) ||
      rows.length > 128 ||
      rows.some((row) => !helperIdPattern.test(String(row.Id ?? row.ID ?? '')))
    )
      throw new Error('Successor census unavailable');
    for (const row of rows) {
      const id = String(row.Id ?? row.ID);
      if (id === helperId) throw new Error('Successor helper remains');
      const detail: unknown = JSON.parse(await this.deps.command(['inspect', id]));
      if (
        !Array.isArray(detail) ||
        detail.length !== 1 ||
        detail[0].Id !== id ||
        !Array.isArray(detail[0].Mounts) ||
        detail[0].Mounts.some(
          (m: { Type?: string; Name?: string }) =>
            !m.Type || (m.Type === 'volume' && (!m.Name || m.Name === intent.volumeName)),
        )
      )
        throw new Error('Successor child has an unaccounted mount');
    }
  }
  assertCopyReceipt(
    intent: ArtifactGenerationIntent,
    receipt: ArtifactGenerationCopyReceipt,
  ): true {
    const row = this.deps.ledger.historical(intent.request, intent.generationId);
    const physical = row.physical;
    const terminal = physical[4];
    if (
      physical.length !== 7 ||
      physical[6].phase !== 'helper_absent' ||
      row.helperId !== receipt.helperId ||
      terminal?.phase !== 'terminal' ||
      terminal.exitCode !== 0 ||
      terminal.proofDigest !== receipt.verificationDigest ||
      receipt.initializationReceiptDigest !==
        digest({ intent, physical, contract: successorCopierContract() })
    )
      throw new Error('Successful retained physical copy proof required');
    return true;
  }
  async copy(
    request: ArtifactGenerationRequest,
    exported: ArtifactParentExport,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<ArtifactGenerationCopyReceipt> {
    this.match(request, exported, bundle);
    await this.check(exported, bundle, signal);
    const { ledger, command } = this.deps;
    const intent = ledger.reserve(request);
    const retained = ledger.verifiedCopy(request, intent.generationId);
    if (retained) {
      this.assertCopyReceipt(intent, retained);
      await this.volume(intent);
      return retained;
    }
    if (!ledger.claimCopy(request, intent.generationId))
      throw new Error('Successor copy already claimed; reconciliation required');
    const observe = (value: Parameters<typeof ledger.observePhysical>[2]) =>
      ledger.observePhysical(request, intent.generationId, value);
    try {
      const names: unknown = JSON.parse(await command(['volume', 'ls', '--format', 'json']));
      if (
        !Array.isArray(names) ||
        names.length > 1024 ||
        names.some((row) => typeof row.Name !== 'string' || row.Name === intent.volumeName)
      )
        throw new Error('Fresh successor volume absence unavailable');
      await this.check(exported, bundle, signal);
      ledger.assertCopyCurrent(request, intent.generationId);
      observe({ phase: 'volume_create_dispatched' });
      const labels = artifactVolumeLabels(request.workspace, {
        sessionId: request.sessionId,
        volumeName: intent.volumeName,
        volumeGeneration: intent.generationId,
      });
      const created = (
        await command([
          'volume',
          'create',
          '--driver',
          'local',
          '--uid',
          String(runtime.workload.uid),
          '--gid',
          String(runtime.workload.gid),
          ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
          intent.volumeName,
        ])
      ).trim();
      if (created !== intent.volumeName) throw new Error('Successor volume creation uncertain');
      observe({ phase: 'volume_created', name: created });
      await this.volume(intent);
      await this.check(exported, bundle, signal);
      ledger.assertCopyCurrent(request, intent.generationId);
      observe({ phase: 'helper_create_dispatched' });
      const helperId = (
        await command([
          'create',
          '--pull=never',
          '--interactive',
          '--name',
          intent.helperName,
          '--label',
          `mitzo.artifact-generation=${intent.generationId}`,
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=32',
          '--memory=256m',
          '--cpus=1',
          '--timeout=50',
          '--user',
          `${runtime.workload.uid}:${runtime.workload.gid}`,
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=16m,mode=1777',
          '--mount',
          `type=volume,src=${intent.volumeName},dst=${SYMPOSIUM_ARTIFACT_TARGET}`,
          '--entrypoint=/usr/bin/python3',
          runtime.build.image,
          '-I',
          '-B',
          '-c',
          ARTIFACT_GIT_SUCCESSOR_IMPORT,
          exported.seal.repositoryPath,
          JSON.stringify({
            expected: exported.seal.git,
            selection: exported.selection,
            bundleSha256: exported.bundleSha256,
            bytes: exported.bytes,
          }),
        ])
      ).trim();
      if (!helperIdPattern.test(helperId)) throw new Error('Successor helper creation uncertain');
      observe({ phase: 'helper_created', helperId });
      await this.inspect(intent, helperId);
      await this.check(exported, bundle, signal);
      ledger.assertCopyCurrent(request, intent.generationId);
      let output: string;
      try {
        output = await command(['start', '--attach', '--interactive', helperId], 16384, bundle);
      } catch {
        // A rejected attach never proves success. Preserve only a fresh observable terminal state.
        const failed = await this.inspect(intent, helperId);
        if (failed.State?.Running === false && Number.isInteger(failed.State.ExitCode))
          observe({
            phase: 'terminal',
            helperId,
            exitCode: failed.State.ExitCode!,
            proofDigest: null,
          });
        throw new Error('Successor attached completion unavailable');
      }
      const terminal = await this.inspect(intent, helperId);
      if (terminal.State?.Running !== false || !Number.isInteger(terminal.State.ExitCode))
        throw new Error('Successor terminal state unknown');
      let proof: unknown;
      try {
        if (Buffer.byteLength(output) <= 16384) proof = JSON.parse(output);
      } catch {
        /* Only a digest of valid bounded output may enter the receipt. */
      }
      observe({
        phase: 'terminal',
        helperId,
        exitCode: terminal.State.ExitCode!,
        proofDigest: proof ? digest(proof) : null,
      });
      if (
        terminal.State.ExitCode !== 0 ||
        canonicalReviewJson(proof) !== canonicalReviewJson(exported.seal.git)
      )
        throw new Error('Successor verification failed');
      await command(['rm', helperId]);
      observe({ phase: 'helper_removed', helperId });
      await this.absent(intent, helperId);
      observe({ phase: 'helper_absent', helperId });
      await this.check(exported, bundle, signal);
      await this.volume(intent);
      const receipt: ArtifactGenerationCopyReceipt = {
        intentDigest: digest(intent),
        generationId: intent.generationId,
        volumeName: intent.volumeName,
        helperName: intent.helperName,
        helperId,
        initializationReceiptDigest: digest({
          intent,
          physical: ledger.historical(request, intent.generationId).physical,
          contract: successorCopierContract(),
        }),
        exportReceiptDigest: digest(exported),
        commit: exported.seal.git.commit,
        tree: exported.seal.git.tree,
        manifestDigest: exported.seal.git.manifestDigest,
        committedTreeDigest: exported.seal.git.committedTreeDigest,
        bundleSha256: exported.bundleSha256,
        terminalExitCode: 0,
        helperRemoved: true,
        verificationDigest: digest(proof),
      };
      this.assertCopyReceipt(intent, receipt);
      ledger.recordCopy(request, intent.generationId, receipt);
      return receipt;
    } catch {
      ledger.quarantine(request, intent.generationId);
      throw new Error('Successor copy failed; exact retained observations require reconciliation');
    }
  }
  async activate(
    request: ArtifactGenerationRequest,
    generationId: string,
    exported: ArtifactParentExport,
    bundle: Buffer,
    signal: AbortSignal,
  ) {
    const row = this.deps.ledger.historical(request, generationId);
    const intent = row.intent;
    if (
      !intent ||
      canonicalReviewJson(intent.request) !== canonicalReviewJson(request) ||
      !row.receipt
    )
      throw new Error('Verified successor identity required');
    this.match(request, exported, bundle);
    await this.check(exported, bundle, signal);
    this.assertCopyReceipt(intent, row.receipt);
    await this.volume(intent);
    await this.absent(intent, row.receipt.helperId);
    await this.check(exported, bundle, signal);
    return this.deps.ledger.activate(request, generationId);
  }
}
