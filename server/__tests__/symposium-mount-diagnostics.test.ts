import { describe, expect, it, vi } from 'vitest';
import type { ArtifactDriverConfig } from '../symposium-artifact-lease.js';
import { SqliteArtifactLeaseHost } from '../symposium-artifact-host.js';
import { LocalPodmanArtifactEvidence } from '../symposium-podman-evidence.js';
import {
  atSymposiumReconciliationStageAsync,
  symposiumReconciliationFailureCode,
} from '../symposium-reconciliation-error.js';
import { SandboxCreationPreflightError } from '../symposium-workspace-lifecycle.js';

const physicalId = 'a'.repeat(64);
const image = 'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161';
const labels = {
  'openshell.ai/sandbox-id': 'sbx-123',
  'openshell.ai/sandbox-name': 'seat-a',
  'openshell.ai/sandbox-workspace': 'symposium-1',
  'openshell.ai/sandbox-namespace': 'gateway-local',
  'openshell.ai/isolation-role': 'sandbox',
  'openshell.managed': 'true',
};
const rows = [{ Id: physicalId, Labels: labels }];
const mount = {
  Type: 'volume',
  Name: 'artifacts-1',
  Destination: '/sandbox/workspaces/mgmt',
  RW: false,
};
const details = {
  Id: physicalId,
  Config: { Labels: labels },
  State: { Running: true },
  Mounts: [mount],
  Image: image,
};
const config: ArtifactDriverConfig = {
  podman: {
    mounts: [
      {
        type: 'volume',
        source: 'artifacts-1',
        target: '/sandbox/workspaces/mgmt',
        read_only: true,
      },
    ],
  },
};
const access = {
  uid: 998,
  gid: 998,
  ownerUid: 998,
  ownerGid: 998,
  mode: '755',
  readable: true,
  searchable: true,
  writable: false,
};
const privateFailure = new Error('credential=private-test-value /private/host-path');

describe('finite physical mount failure diagnostics', () => {
  it.each([
    { name: 'invalid sandbox identity', sandboxId: '', code: 'SEAT_MOUNT_CONFIG_FAILED', calls: 0 },
    { name: 'ambiguous config', config: {}, code: 'SEAT_MOUNT_CONFIG_FAILED', calls: 0 },
    {
      name: 'invalid expected mount',
      config: { podman: { mounts: [{ ...config.podman!.mounts[0], source: 'invalid/source' }] } },
      code: 'SEAT_MOUNT_CONFIG_FAILED',
      calls: 0,
    },
    {
      name: 'listing command rejected',
      listError: privateFailure,
      code: 'SEAT_MOUNT_LISTING_FAILED',
      calls: 1,
    },
    { name: 'listing malformed', rows: {}, code: 'SEAT_MOUNT_LISTING_FAILED', calls: 1 },
    {
      name: 'listing labels malformed',
      rows: [{ Id: physicalId, Labels: null }],
      code: 'SEAT_MOUNT_LISTING_FAILED',
      calls: 1,
    },
    { name: 'workload missing', rows: [], code: 'SEAT_MOUNT_SELECTION_FAILED', calls: 1 },
    {
      name: 'duplicate generations',
      rows: [
        ...rows,
        { Id: 'b'.repeat(64), Labels: { ...labels, 'openshell.ai/sandbox-id': 'old' } },
      ],
      code: 'SEAT_MOUNT_SELECTION_FAILED',
      calls: 1,
    },
    {
      name: 'physical ID malformed',
      rows: [{ Id: 'invalid/id', Labels: labels }],
      code: 'SEAT_MOUNT_SELECTION_FAILED',
      calls: 1,
    },
    {
      name: 'inspection command rejected',
      inspectError: privateFailure,
      code: 'SEAT_MOUNT_INSPECTION_FAILED',
      calls: 2,
    },
    { name: 'inspection malformed', inspected: [], code: 'SEAT_MOUNT_INSPECTION_FAILED', calls: 2 },
    {
      name: 'identity changed',
      inspected: [{ ...details, Id: 'b'.repeat(64) }],
      code: 'SEAT_MOUNT_IDENTITY_FAILED',
      calls: 2,
    },
    {
      name: 'namespace changed',
      inspected: [
        {
          ...details,
          Config: { Labels: { ...labels, 'openshell.ai/sandbox-namespace': 'other' } },
        },
      ],
      code: 'SEAT_MOUNT_IDENTITY_FAILED',
      calls: 2,
    },
    {
      name: 'sandbox stopped',
      inspected: [{ ...details, State: { Running: false } }],
      code: 'SEAT_MOUNT_IDENTITY_FAILED',
      calls: 2,
    },
    {
      name: 'mounts unavailable',
      inspected: [{ ...details, Mounts: null }],
      code: 'SEAT_MOUNT_PHYSICAL_PROOF_FAILED',
      calls: 2,
    },
    {
      name: 'mount target missing',
      inspected: [{ ...details, Mounts: [] }],
      code: 'SEAT_MOUNT_PHYSICAL_PROOF_FAILED',
      calls: 2,
    },
    {
      name: 'access drifted',
      inspected: [{ ...details, Mounts: [{ ...mount, RW: true }] }],
      code: 'SEAT_MOUNT_PHYSICAL_PROOF_FAILED',
      calls: 2,
    },
    {
      name: 'image changed',
      inspected: [{ ...details, Image: 'b'.repeat(64) }],
      code: 'SEAT_MOUNT_IMAGE_FAILED',
      calls: 2,
    },
    {
      name: 'native probe unavailable',
      nativeUnavailable: true,
      code: 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
      calls: 2,
    },
    {
      name: 'native probe rejected',
      nativeError: privateFailure,
      code: 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
      calls: 2,
    },
    {
      name: 'access proof rejected',
      access: { ...access, readable: false },
      code: 'SEAT_MOUNT_ACCESS_PROOF_FAILED',
      calls: 2,
    },
    {
      name: 'postcheck rejected',
      postError: privateFailure,
      code: 'SEAT_MOUNT_POSTCHECK_FAILED',
      calls: 3,
    },
  ])('preserves the safe stage for $name through dispatch fences', async (testCase) => {
    const run = vi.fn();
    if ('listError' in testCase) run.mockRejectedValueOnce(testCase.listError);
    else run.mockResolvedValueOnce('rows' in testCase ? testCase.rows : rows);
    if ('inspectError' in testCase) run.mockRejectedValueOnce(testCase.inspectError);
    else run.mockResolvedValueOnce('inspected' in testCase ? testCase.inspected : [details]);
    if ('postError' in testCase) run.mockRejectedValueOnce(testCase.postError);
    else run.mockResolvedValueOnce([details]);
    const native = vi.fn();
    if ('nativeError' in testCase) native.mockRejectedValueOnce(testCase.nativeError);
    else native.mockResolvedValueOnce('access' in testCase ? testCase.access : access);
    const evidence = new LocalPodmanArtifactEvidence(
      'symposium-1',
      'gateway-local',
      run,
      undefined,
      image,
      'nativeUnavailable' in testCase ? undefined : native,
    );
    const failure = await atSymposiumReconciliationStageAsync(
      'SEAT_MOUNT_VERIFICATION_FAILED',
      () =>
        evidence.verifyMount(
          'seat-a',
          testCase.sandboxId ?? 'sbx-123',
          'config' in testCase ? (testCase.config as ArtifactDriverConfig) : config,
        ),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: testCase.code, message: testCase.code });
    expect(symposiumReconciliationFailureCode(failure)).toBe(testCase.code);
    expect(symposiumReconciliationFailureCode(new SandboxCreationPreflightError(failure))).toBe(
      testCase.code,
    );
    expect(run).toHaveBeenCalledTimes(testCase.calls);
    if (
      !testCase.code.includes('NATIVE_ACCESS') &&
      !testCase.code.includes('ACCESS_PROOF') &&
      !testCase.code.includes('POSTCHECK')
    )
      expect(native).not.toHaveBeenCalled();
    expect(
      JSON.stringify({
        code: symposiumReconciliationFailureCode(failure),
        message: (failure as Error).message,
      }),
    ).not.toContain('private-test-value');
    expect(JSON.stringify(failure)).not.toContain('private-test-value');
  });

  it('classifies the lease host identity precheck before querying evidence', async () => {
    const verifyMount = vi.fn();
    const host = new SqliteArtifactLeaseHost(
      ':memory:',
      { verifyMount, verifyGateway: vi.fn() },
      vi.fn(async () => []),
    );
    try {
      const failure = await atSymposiumReconciliationStageAsync(
        'SEAT_MOUNT_VERIFICATION_FAILED',
        () => host.verifyPhysicalMount('invalid/seat', 'sbx-123', config),
      ).catch((error: unknown) => error);
      expect(symposiumReconciliationFailureCode(failure)).toBe('SEAT_MOUNT_CONFIG_FAILED');
      expect(verifyMount).not.toHaveBeenCalled();
    } finally {
      host.close();
    }
  });

  it('does not accept untrusted error codes or traverse arbitrary cause chains', () => {
    const external = Object.assign(privateFailure, { code: 'SEAT_MOUNT_IMAGE_FAILED' });
    expect(symposiumReconciliationFailureCode(external)).toBe('RECONCILIATION_FAILED');
    expect(symposiumReconciliationFailureCode({ cause: external })).toBe('RECONCILIATION_FAILED');
  });
});
