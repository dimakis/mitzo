/** Host-owned admission for an OpenShell 0.1.0 named artifact volume.
 * The caller must obtain volume metadata and lease decisions from the host,
 * never from a sandbox or a model-produced value.
 */

export const SYMPOSIUM_ARTIFACT_TARGET = '/sandbox/symposium-artifacts';

export type ArtifactDriver = 'docker' | 'podman';
export type ArtifactAccess = 'writer' | 'reviewer';

export interface ArtifactVolumeEvidence {
  name: string;
  driver: 'local';
  /** Host volume labels, including the immutable generation bound to this volume. */
  labels: Record<string, string>;
  /** Local driver options can turn a named volume into a host bind. */
  options: Record<string, string>;
}

export interface ArtifactLeaseRequest {
  sessionId: string;
  workspaceId: string;
  seatId: string;
  volumeName: string;
  volumeGeneration: string;
  driver: ArtifactDriver;
  access: ArtifactAccess;
}

export interface ArtifactLease {
  token: string;
  request: ArtifactLeaseRequest;
  /** Host lease generation. A stale descriptor must not be reused. */
  revision: string;
}

export interface ArtifactLeaseHost {
  inspectVolume(name: string, driver: ArtifactDriver): Promise<ArtifactVolumeEvidence>;
  /** Confirm the selected gateway permits this exact driver config and workspace. */
  verifyDriverConfig(request: ArtifactLeaseRequest, config: ArtifactDriverConfig): Promise<void>;
  /** Atomic admission: only one writer for a volume, irrespective of seat/session. */
  reserve(request: ArtifactLeaseRequest): Promise<ArtifactLease>;
  /** Must read the current host record, not return a cached reservation. */
  inspectLease(token: string): Promise<ArtifactLease | null>;
  release(token: string): Promise<void>;
}

export type ArtifactDriverConfig = Partial<
  Record<
    ArtifactDriver,
    {
      mounts: { type: 'volume'; source: string; target: string; read_only: boolean }[];
    }
  >
>;

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function assertRequest(request: ArtifactLeaseRequest): void {
  for (const key of ['sessionId', 'workspaceId', 'seatId', 'volumeGeneration'] as const) {
    if (!ID.test(request[key])) throw new Error(`Invalid artifact ${key}`);
  }
  if (!VOLUME.test(request.volumeName)) throw new Error('Invalid artifact volume name');
  if (request.driver !== 'docker' && request.driver !== 'podman')
    throw new Error('Unsupported artifact volume driver');
  if (request.access !== 'writer' && request.access !== 'reviewer')
    throw new Error('Unsupported artifact access');
}

function assertVolume(request: ArtifactLeaseRequest, volume: ArtifactVolumeEvidence): void {
  if (volume.name !== request.volumeName || volume.driver !== 'local')
    throw new Error('Artifact volume identity drift');
  if (Object.keys(volume.options).length !== 0)
    throw new Error('Artifact volume uses host-backed driver options');
  const labels = volume.labels;
  const requiredLabels = [
    'openshell.ai/sandbox-attachable',
    'openshell.ai/sandbox-attachable-workspace',
    'mitzo.symposium.purpose',
    'mitzo.symposium.session',
    'mitzo.symposium.workspace',
    'mitzo.symposium.generation',
  ];
  if (Object.keys(labels).sort().join(',') !== requiredLabels.sort().join(','))
    throw new Error('Artifact volume has unexpected admission labels');
  if (
    labels['mitzo.symposium.purpose'] !== 'artifacts' ||
    labels['mitzo.symposium.session'] !== request.sessionId ||
    labels['mitzo.symposium.workspace'] !== request.workspaceId ||
    labels['mitzo.symposium.generation'] !== request.volumeGeneration ||
    labels['openshell.ai/sandbox-attachable'] !== 'true' ||
    labels['openshell.ai/sandbox-attachable-workspace'] !== request.workspaceId
  )
    throw new Error('Artifact volume admission labels do not match');
}

function sameRequest(a: ArtifactLeaseRequest, b: ArtifactLeaseRequest): boolean {
  return (Object.keys(a) as (keyof ArtifactLeaseRequest)[]).every((key) => a[key] === b[key]);
}

/** Reserve, then recheck host evidence after the asynchronous reservation. */
export async function acquireSymposiumArtifactLease(
  host: ArtifactLeaseHost,
  request: ArtifactLeaseRequest,
): Promise<ArtifactLease> {
  assertRequest(request);
  assertVolume(request, await host.inspectVolume(request.volumeName, request.driver));
  const lease = await host.reserve(request);
  if (!lease.token || !lease.revision || !sameRequest(lease.request, request))
    throw new Error('Artifact reservation identity drift');
  assertVolume(request, await host.inspectVolume(request.volumeName, request.driver));
  const current = await host.inspectLease(lease.token);
  if (
    !current ||
    current.token !== lease.token ||
    current.revision !== lease.revision ||
    !sameRequest(current.request, request)
  )
    throw new Error('Artifact lease drift');
  // reserve may have returned a durable lease from an earlier ensure. Never
  // release it after a failed recheck: its sandbox may already exist.
  return lease;
}

/** Revalidate immediately before sandbox creation or reuse. */
export async function artifactDriverConfigForLease(
  host: ArtifactLeaseHost,
  lease: ArtifactLease,
): Promise<ArtifactDriverConfig> {
  const request = lease.request;
  assertRequest(request);
  assertVolume(request, await host.inspectVolume(request.volumeName, request.driver));
  const current = await host.inspectLease(lease.token);
  if (
    !current ||
    current.revision !== lease.revision ||
    current.token !== lease.token ||
    !sameRequest(current.request, request)
  )
    throw new Error('Artifact lease drift');
  const config: ArtifactDriverConfig = {
    [request.driver]: {
      mounts: [
        {
          type: 'volume',
          source: request.volumeName,
          target: SYMPOSIUM_ARTIFACT_TARGET,
          read_only: request.access !== 'writer',
        },
      ],
    },
  };
  await host.verifyDriverConfig(request, config);
  // Gateway selection/configuration can change while the host verifies policy.
  assertVolume(request, await host.inspectVolume(request.volumeName, request.driver));
  const afterVerification = await host.inspectLease(lease.token);
  if (
    !afterVerification ||
    afterVerification.revision !== lease.revision ||
    afterVerification.token !== lease.token ||
    !sameRequest(afterVerification.request, request)
  )
    throw new Error('Artifact lease drift');
  return config;
}
