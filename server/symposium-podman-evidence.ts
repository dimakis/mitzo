import type { OpenShellMountJsonOperation, OpenShellRuntimeConfig } from './openshell-runtime.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import {
  probeOwnedArtifactAccess,
  type NativeArtifactAccessProbe,
} from './symposium-artifact-native-access.js';
import { symposiumArtifactOwner } from './symposium-artifact-owner.js';
import { isPodmanSandboxNamespace } from './symposium-podman-namespace.js';
import { execFile } from 'node:child_process';
import type { ArtifactDriverConfig, ArtifactLeaseRequest } from './symposium-artifact-lease.js';
import type { ArtifactHostEvidence } from './symposium-artifact-host.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import {
  atSymposiumReconciliationStage,
  atSymposiumReconciliationStageAsync,
} from './symposium-reconciliation-error.js';

type PodmanCommand = (
  args: readonly string[],
  observation?: OpenShellMountJsonOperation,
) => Promise<unknown>;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const containerId = /^[a-f0-9]{12,64}$/i;
const target = SYMPOSIUM_ARTIFACT_TARGET;

/** Podman host metadata only; native access is checked separately through owned SSH. */
export const localPodmanCommand: PodmanCommand = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'podman',
      [...args],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Podman host inspection result');
  return value as Record<string, unknown>;
}

function labels(value: unknown): Record<string, unknown> {
  return record(value);
}

function exactlyOne(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Podman did not return exactly one physical container');
  return record(value[0]);
}

/**
 * Inspects the physical workload by OpenShell's driver-owned labels. This
 * deliberately does not use a caller-provided container name as a selector.
 *
 * OpenShell's config preflight only checks a file. Gateway CLI/environment
 * options can override that file, so it cannot attest the *running* gateway's
 * allow_driver_config setting. Until a trusted effective-config source is
 * supplied, gateway admission and deletion remain closed.
 */
export class LocalPodmanArtifactEvidence implements ArtifactHostEvidence {
  constructor(
    private readonly workspaceId: string,
    private readonly sandboxNamespace: string,
    private readonly run: PodmanCommand = localPodmanCommand,
    private readonly ownedGateway?: OwnedSymposiumGateway,
    private readonly workloadImage?: string,
    private readonly nativeAccess?: NativeArtifactAccessProbe,
    private readonly observeRuntime?: OpenShellRuntimeConfig['observeRuntime'],
  ) {
    if (!identifier.test(workspaceId) || !isPodmanSandboxNamespace(sandboxNamespace))
      throw new Error('Invalid expected OpenShell workspace or namespace');
  }

  async verifyGateway(request: ArtifactLeaseRequest, config: ArtifactDriverConfig): Promise<void> {
    if (
      request.driver !== 'podman' ||
      request.workspaceId !== this.workspaceId ||
      Object.keys(config).length !== 1 ||
      !config.podman
    )
      throw new Error('Selected OpenShell gateway differs from artifact lease');
    if (!this.ownedGateway)
      throw new Error('Selected gateway effective Podman admission config is not host-attested');
    await this.ownedGateway.verifyGateway(request, config);
  }

  async verifyMount(
    sandboxName: string,
    sandboxId: string,
    config: ArtifactDriverConfig,
  ): Promise<void> {
    if (!identifier.test(sandboxName) || !identifier.test(sandboxId))
      throw new Error('Invalid OpenShell sandbox identity');
    if (Object.keys(config).length !== 1 || !config.podman || config.podman.mounts.length !== 1)
      throw new Error('Podman artifact driver config is ambiguous');
    const expected = config.podman.mounts[0];
    if (
      expected.type !== 'volume' ||
      expected.target !== target ||
      !identifier.test(expected.source) ||
      typeof expected.read_only !== 'boolean'
    )
      throw new Error('Invalid expected artifact mount');

    // List all containers so an incorrect daemon-side label filter cannot
    // accidentally turn a live sandbox into an apparent absence.
    const run = (args: readonly string[], operation: OpenShellMountJsonOperation) =>
      this.observeRuntime ? this.run(args, operation) : this.run(args);
    const listed = await run(['ps', '--all', '--format', 'json'], 'podman-ps');
    if (!Array.isArray(listed)) throw new Error('Invalid Podman container listing');
    // A replacement ID does not prove the previous physical workload stopped.
    // Include the stable identity so both generations cannot pass mount admission.
    const workload = listed.filter((item) => {
      const row = record(item);
      const foundLabels = labels(row.Labels ?? row.labels);
      return (
        foundLabels['openshell.ai/isolation-role'] === 'sandbox' &&
        (foundLabels['openshell.ai/sandbox-id'] === sandboxId ||
          (foundLabels['openshell.ai/sandbox-name'] === sandboxName &&
            foundLabels['openshell.ai/sandbox-workspace'] === this.workspaceId &&
            foundLabels['openshell.ai/sandbox-namespace'] === this.sandboxNamespace))
      );
    });
    const workloadRow = exactlyOne(workload);
    const physicalId = workloadRow.Id ?? workloadRow.ID;
    if (typeof physicalId !== 'string' || !containerId.test(physicalId))
      throw new Error('Podman physical container ID is unavailable');
    const inspected = exactlyOne(
      await run(['inspect', '--type', 'container', physicalId], 'podman-inspect'),
    );
    if (inspected.Id !== physicalId && inspected.ID !== physicalId)
      throw new Error('Podman container identity changed during inspection');
    const found = labels(inspected.Config && record(inspected.Config).Labels);
    const required: Record<string, string> = {
      'openshell.ai/sandbox-id': sandboxId,
      'openshell.ai/sandbox-name': sandboxName,
      'openshell.ai/sandbox-workspace': this.workspaceId,
      'openshell.ai/sandbox-namespace': this.sandboxNamespace,
      'openshell.ai/isolation-role': 'sandbox',
      'openshell.managed': 'true',
    };
    for (const [key, value] of Object.entries(required))
      if (found[key] !== value) throw new Error(`Podman sandbox ${key} does not match`);
    const state = record(inspected.State);
    if (state.Running !== true) throw new Error('Podman sandbox is not running');
    if (!Array.isArray(inspected.Mounts)) throw new Error('Podman mounts are unavailable');
    const atTarget = inspected.Mounts.map(record).filter((mount) => mount.Destination === target);
    if (atTarget.length !== 1) throw new Error('Artifact target has no unique physical mount');
    const mount = atTarget[0];
    if (
      mount.Type !== 'volume' ||
      mount.Name !== expected.source ||
      mount.RW !== !expected.read_only
    )
      throw new Error('Physical artifact volume or access differs from lease');
    if (this.workloadImage) {
      const owner = symposiumArtifactOwner(this.workloadImage);
      const image =
        typeof inspected.Image === 'string' ? inspected.Image.replace(/^sha256:/, '') : '';
      if (image !== owner.image.replace(/^sha256:/, ''))
        throw new Error('Artifact workload image differs from reviewed identity');
      // Read-only OS evidence under the image's own sandbox identity. This never
      // writes a marker into the shared artifact volume or runs a model.
      const nativeAccess =
        this.nativeAccess ??
        (this.ownedGateway
          ? (name: string, id: string, script: string) =>
              probeOwnedArtifactAccess(this.ownedGateway!, name, id, script, this.observeRuntime)
          : undefined);
      if (!nativeAccess) throw new Error('Native artifact identity probe is unavailable');
      const probe = await atSymposiumReconciliationStageAsync(
        'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
        async () =>
          record(
            await nativeAccess(
              sandboxName,
              sandboxId,
              'set -eu; uid=$(/usr/bin/id -u); gid=$(/usr/bin/id -g); set -- $(/usr/bin/stat -c "%u %g %a" __ARTIFACT_TARGET__); readable=false; searchable=false; if test -r __ARTIFACT_TARGET__; then readable=true; fi; if test -x __ARTIFACT_TARGET__; then searchable=true; fi; writable=false; if test -w __ARTIFACT_TARGET__; then writable=true; fi; printf \'{"uid":%s,"gid":%s,"ownerUid":%s,"ownerGid":%s,"mode":"%s","writable":%s,"readable":%s,"searchable":%s}\\n\' "$uid" "$gid" "$1" "$2" "$3" "$writable" "$readable" "$searchable"'.replaceAll(
                '__ARTIFACT_TARGET__',
                target,
              ),
            ),
          ),
      );
      atSymposiumReconciliationStage('SEAT_MOUNT_ACCESS_PROOF_FAILED', () => {
        if (
          probe.uid !== owner.uid ||
          probe.gid !== owner.gid ||
          probe.ownerUid !== owner.uid ||
          probe.ownerGid !== owner.gid ||
          typeof probe.mode !== 'string' ||
          !/^[0-7]{3,4}$/.test(probe.mode) ||
          (Number.parseInt(probe.mode, 8) & 0o022) !== 0 ||
          probe.readable !== true ||
          probe.searchable !== true ||
          probe.writable !== !expected.read_only
        )
          throw new Error('Artifact owner identity or effective access is not ready');
      });
      await atSymposiumReconciliationStageAsync('SEAT_MOUNT_POSTCHECK_FAILED', async () => {
        const after = exactlyOne(
          await run(['inspect', '--type', 'container', physicalId], 'podman-inspect'),
        );
        const afterLabels = labels(record(after.Config).Labels);
        const afterMounts = Array.isArray(after.Mounts)
          ? after.Mounts.map(record).filter((mount) => mount.Destination === target)
          : [];
        if (
          (after.Id ?? after.ID) !== physicalId ||
          Object.entries(required).some(([key, value]) => afterLabels[key] !== value) ||
          record(after.State).Running !== true ||
          after.Image !== inspected.Image ||
          afterMounts.length !== 1 ||
          afterMounts[0].Type !== 'volume' ||
          afterMounts[0].Name !== expected.source ||
          afterMounts[0].RW !== !expected.read_only
        )
          throw new Error('Artifact physical identity changed during native access probe');
      });
    }
  }

  async verifyDeleted(sandboxName: string, sandboxId: string): Promise<void> {
    if (!identifier.test(sandboxName) || !identifier.test(sandboxId))
      throw new Error('Invalid OpenShell sandbox identity');
    const listed = await this.run(['ps', '--all', '--format', 'json']);
    if (!Array.isArray(listed)) throw new Error('Invalid Podman container listing');
    if (
      listed.some((item) => {
        const found = labels(record(item).Labels ?? record(item).labels);
        return (
          found['openshell.ai/sandbox-id'] === sandboxId ||
          (found['openshell.ai/sandbox-name'] === sandboxName &&
            found['openshell.ai/sandbox-workspace'] === this.workspaceId &&
            found['openshell.ai/sandbox-namespace'] === this.sandboxNamespace)
        );
      })
    )
      throw new Error('Physical OpenShell sandbox resources remain');
    // The caller must separately attest gateway deletion and fresh absence.
  }
}
