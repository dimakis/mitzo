import { execFile } from 'node:child_process';
import type { ArtifactDriverConfig, ArtifactLeaseRequest } from './symposium-artifact-lease.js';
import type { ArtifactHostEvidence } from './symposium-artifact-host.js';

type PodmanCommand = (args: readonly string[]) => Promise<unknown>;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const containerId = /^[a-f0-9]{12,64}$/i;
const target = '/sandbox/symposium-artifacts';

/** The local Podman API is host evidence; stdout from a sandbox is never used. */
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
  ) {
    if (!identifier.test(workspaceId) || !identifier.test(sandboxNamespace))
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
    throw new Error('Selected gateway effective Podman admission config is not host-attested');
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
    const listed = await this.run(['ps', '--all', '--format', 'json']);
    if (!Array.isArray(listed)) throw new Error('Invalid Podman container listing');
    const workload = listed.filter((item) => {
      const row = record(item);
      const foundLabels = labels(row.Labels ?? row.labels);
      return (
        foundLabels['openshell.ai/sandbox-id'] === sandboxId &&
        foundLabels['openshell.ai/isolation-role'] === 'sandbox'
      );
    });
    const workloadRow = exactlyOne(workload);
    const physicalId = workloadRow.Id ?? workloadRow.ID;
    if (typeof physicalId !== 'string' || !containerId.test(physicalId))
      throw new Error('Podman physical container ID is unavailable');
    const inspected = exactlyOne(await this.run(['inspect', '--type', 'container', physicalId]));
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
