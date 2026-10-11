import { expect, it, vi } from 'vitest';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { OFFLINE_CONTAINMENT_TARGET } from '../../scripts/lib/staging-offline-containment-contract.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import {
  assessOfflineContainment,
  observeOfflineContainment,
  inspectOpaqueContainmentTree,
  inspectOpaquePreservationTree,
  classifyCanonicalJobAbsence,
  validateAppleHvContainmentMachine,
  assertDirectRawDiskHeader,
  assertScopedNoOpenHandles,
  assertNoScopedMountAliases,
  OFFLINE_CONTAINMENT_NATIVE_TARGET,
  assertOfflineContainmentBeforeMove,
  assertOfflineContainmentContained,
  assertPublicVmMetadataPath,
  createOfflineContainmentInspectionOwner,
  validateOrdinaryReplacementObservation,
  offlineContainmentNativeHelper,
  assertOpaqueContainmentManifest,
  assertCleanPreparedControllerStatus,
  scopedLsofArguments,
  observeStoppedAppleHvEndpoint,
  deriveAppleHvApiSocket,
} from '../../scripts/lib/staging-offline-containment-observation.mjs';
import { runOfflineRecovery } from '../../scripts/recover-staging-offline.mjs';

const sha = 'a'.repeat(64);
it('requires exact frozen AppleHV endpoint and literal dual-loopback refusal without DNS or native commands', async () => {
  const endpoint = 'http://localhost:62752';
  async function probe(outcomes) {
    const sockets = [];
    const connect = vi.fn(({ host }) => {
      const socket = new EventEmitter();
      socket.destroy = vi.fn();
      sockets.push(socket);
      globalThis.queueMicrotask(() => {
        const outcome = outcomes[host];
        if (outcome === 'connect') socket.emit('connect');
        else if (outcome !== 'timeout')
          socket.emit('error', Object.assign(Error('synthetic'), { code: outcome }));
      });
      return socket;
    });
    return {
      promise: observeStoppedAppleHvEndpoint(endpoint, { connect, timeoutMs: 10 }),
      sockets,
      connect,
    };
  }
  const accepted = await probe({ '127.0.0.1': 'ECONNREFUSED', '::1': 'ECONNREFUSED' });
  expect(await accepted.promise).toMatchObject({
    method: 'literal_dual_loopback_tcp_refusal',
    endpoint,
  });
  expect(accepted.connect.mock.calls.map(([options]) => options)).toEqual([
    { host: '127.0.0.1', port: 62752, family: 4 },
    { host: '::1', port: 62752, family: 6 },
  ]);
  for (const socket of accepted.sockets) socket.emit('close');
  for (const outcome of ['connect', 'timeout', 'EHOSTUNREACH', undefined]) {
    const rejected = await probe({ '127.0.0.1': 'ECONNREFUSED', '::1': outcome });
    await expect(rejected.promise).rejects.toThrow(/refusal/);
    for (const socket of rejected.sockets) {
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(() => socket.emit('error', Error('delayed pending-connect error'))).not.toThrow();
      socket.emit('close');
      expect(socket.eventNames()).toEqual([]);
    }
  }
  const connect = vi.fn();
  for (const value of [
    'http://127.0.0.1:62752',
    'http://localhost:62753',
    'https://localhost:62752',
    'http://localhost:62752/path',
  ])
    await expect(observeStoppedAppleHvEndpoint(value, { connect })).rejects.toThrow(/endpoint/);
  expect(connect).not.toHaveBeenCalled();
  expect(deriveAppleHvApiSocket('mitzo-symposium-staging')).toBe(
    '/private/tmp/podman/mitzo-symposium-staging-api.sock',
  );
  expect(() => deriveAppleHvApiSocket('other')).toThrow();
  const source = readFileSync(
    new URL('../../scripts/lib/staging-offline-containment-observation.mjs', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/['"]machine['"],\s*['"]inspect['"]/);
});
it('places every scoped lsof option before file operands', () => {
  expect(scopedLsofArguments(['/one', '/two'])).toEqual(['-nP', '-Fpn', '/one', '/two']);
  expect(scopedLsofArguments(['/unit'], true)).toEqual(['-nP', '-Fpn', '+D', '/unit']);
});
it('refuses mounted source ancestors exposing original or future quarantine state', () => {
  const root = '/Users/operator/.local/share/mitzo-staging';
  for (const protectedPath of [root + '/symposium', root + '-quarantine']) {
    for (const source of [
      '/',
      '/Users/operator/.local/share',
      '/Users/operator/.local/share/',
      protectedPath,
      protectedPath + '/home',
    ])
      expect(() =>
        assertNoScopedMountAliases(`${source} on /external-alias (bind)\n`, [protectedPath]),
      ).toThrow(/alias/);
    expect(() =>
      assertNoScopedMountAliases('/dev/disk3s5 on /System/Volumes/Data (apfs, local)\n', [
        protectedPath,
      ]),
    ).not.toThrow();
    expect(() =>
      assertNoScopedMountAliases('/Users/operator/.local\\011share on /alias (bind)\n', [
        protectedPath,
      ]),
    ).toThrow(/escape/);
  }
});
it('preserves only the exact closed native ignition socket without treating its birth as preboot', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ig-')));
  try {
    const opaque = join(parent, 's');
    for (const part of [
      'home/.podman',
      'home/.config/containers/podman/machine/applehv',
      'home/.local/share/containers/podman/machine/applehv',
    ])
      mkdirSync(join(opaque, part), { recursive: true, mode: 0o700 });
    for (const file of [
      'home/.config/containers/podman/machine/applehv/mitzo-symposium-staging.json',
      'home/.local/share/containers/podman/machine/applehv/mitzo-symposium-staging-arm64.raw',
      'home/.local/share/containers/podman/machine/applehv/efi-bl-mitzo-symposium-staging',
      'home/.local/share/containers/podman/machine/machine',
    ])
      writeFileSync(join(opaque, file), 'synthetic');
    const socket = join(opaque, 'home/.podman/mitzo-symposium-staging-ignition.sock');
    const result = spawnSync(
      'python3',
      [
        '-c',
        'import socket,sys,os; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); os.chmod(sys.argv[1],0o755); s.close()',
        basename(socket),
      ],
      { timeout: 3000, cwd: dirname(socket) },
    );
    expect(result.status).toBe(0);
    expect(() => inspectOpaquePreservationTree(opaque)).toThrow(/unsupported/);
    const socketCommand = vi.fn(() => ({ status: 1, stdout: '', stderr: '' }));
    const inspect = (path) =>
      inspectOpaqueContainmentTree(path, undefined, { command: socketCommand });
    const before = inspect(opaque);
    expect(socketCommand).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      ['-nP', '-Fpn', socket],
      undefined,
      true,
    );
    for (const result of [
      { status: 0, stdout: 'p123\n', stderr: '' },
      { status: 1, stdout: '', stderr: 'unknown observation' },
      { status: null, stdout: '', stderr: '', error: Error('unavailable') },
    ]) {
      socketCommand.mockReturnValueOnce(result);
      expect(() => inspect(opaque)).toThrow(/handles/);
    }
    const archived = join(parent, 'archived');
    renameSync(opaque, archived);
    expect(inspect(archived).sha256).toBe(before.sha256);
    renameSync(
      join(archived, 'home/.podman/mitzo-symposium-staging-ignition.sock'),
      join(archived, 'home/.podman/other.sock'),
    );
    expect(() => inspect(archived)).toThrow(/unsupported/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
it('preserves a generic private state tree without native components while retaining identity and alias checks', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-generic-preservation-')));
  try {
    const state = join(parent, 'state');
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(join(state, 'opaque.db'), 'synthetic opaque state', { mode: 0o600 });
    const before = inspectOpaquePreservationTree(state);
    expect(before.aliasFree).toBe(true);
    expect(before.bytes).toBe(22);
    expect(() => inspectOpaqueContainmentTree(state)).toThrow(/machine component missing/);
    const archive = join(parent, 'archived');
    renameSync(state, archive);
    expect(inspectOpaquePreservationTree(archive).sha256).toBe(before.sha256);
    symlinkSync(join(archive, 'opaque.db'), join(archive, 'alias'));
    expect(() => inspectOpaquePreservationTree(archive)).toThrow(/alias/);
    rmSync(join(archive, 'alias'));
    linkSync(join(archive, 'opaque.db'), join(archive, 'hard-alias'));
    expect(() => inspectOpaquePreservationTree(archive)).toThrow(/alias/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
it('permits only the canonical generated receipt during prepared source qualification', () => {
  const root = '/private/test/mitzo-staging',
    commit = 'a'.repeat(40);
  const release = join(root, 'releases', commit.slice(0, 12));
  for (const status of ['', '?? staging-release.json'])
    expect(() => assertCleanPreparedControllerStatus(status, root, release, commit)).not.toThrow();
  for (const status of [
    ' M server/index.ts',
    '?? arbitrary.json',
    '?? staging-release.json\n?? arbitrary.json',
    ' M staging-release.json',
    '?? nested/staging-release.json',
  ])
    expect(() => assertCleanPreparedControllerStatus(status, root, release, commit)).toThrow();
  expect(() =>
    assertCleanPreparedControllerStatus('?? staging-release.json', root, '/private/other', commit),
  ).toThrow();
});
it('recognizes only the exact missing canonical launchctl service response', () => {
  expect(
    classifyCanonicalJobAbsence(
      {
        status: 113,
        stdout: '',
        stderr:
          'Bad request.\nCould not find service "com.mitzo.staging" in domain for user gui: 501\n',
      },
      501,
    ),
  ).toEqual({ status: 'absent' });
  for (const result of [
    { status: 113, stdout: '', stderr: '' },
    { status: 1, stdout: '', stderr: 'permission denied' },
    {
      status: 113,
      stdout: '',
      stderr: 'Could not find service "another" in domain for user gui: 501',
    },
    { status: 0, stdout: 'state = not running', stderr: '' },
  ])
    expect(classifyCanonicalJobAbsence(result, 501)).toEqual({ status: 'unknown' });
});
function evidence() {
  const root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archiveRoot = root + '-quarantine/33333333-3333-4333-8333-333333333333';
  return {
    version: 1,
    operatorUid: process.getuid(),
    canonicalRoot: root,
    archiveRoot,
    futureRoots: [root],
    original: {
      ...OFFLINE_CONTAINMENT_TARGET.original,
      ownerBirthAt: OFFLINE_CONTAINMENT_TARGET.original.createdAt - 1790,
    },
    currentBoot: { ...OFFLINE_CONTAINMENT_TARGET.currentBoot },
    retained: {
      state: 'retirement_uncertain',
      rowSha256: sha,
      intentSha256: sha,
      retirementReceipt: 'absent',
    },
    scope: {
      nativeExecution: 'selected_vm_only',
      hostOperations: 'none',
      inventory: 'configured_unit_manifest',
    },
    units: [
      {
        kind: 'opaque_symposium',
        path: root + '/symposium',
        archivePath: archiveRoot + '/symposium',
        manifestSha256: sha,
        uid: process.getuid(),
        mode: 0o700,
        components: Object.fromEntries(
          ['home', 'workspace', 'gateway', 'settings', 'service', 'machine', 'diskChain'].map(
            (key) => [key, sha],
          ),
        ),
      },
    ],
    controls: [
      {
        kind: 'app',
        path: root + '/service/com.mitzo.staging.plist',
        archivePath: archiveRoot + '/controls/com.mitzo.staging.plist',
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'absent',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.appPlistSha256,
        label: 'com.mitzo.staging',
      },
      {
        kind: 'vm_supervisor',
        path: join(homedir(), 'Library/LaunchAgents/com.mitzo.staging.vm.plist'),
        archivePath: archiveRoot + '/controls/com.mitzo.staging.vm.plist',
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'loaded_stopped',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.vmPlistSha256,
        label: 'com.mitzo.staging.vm',
      },
    ],
    nativeHelpers: OFFLINE_CONTAINMENT_NATIVE_TARGET.helpers.map((pin) => ({ ...pin })),
    proofs: Object.fromEntries(
      [
        'dispatchClosure',
        'vmStopped',
        'noOpenHandles',
        'noMountedAliases',
        'autostartDisabled',
        'archiveExcluded',
        'completeOpaqueState',
        'noStateAliases',
      ].map((key) => [
        key,
        ['dispatchClosure', 'autostartDisabled', 'archiveExcluded'].includes(key)
          ? { status: 'unknown', reason: 'Authenticated relocation remains required' }
          : { status: 'confirmed', evidenceSha256: sha },
      ]),
    ),
  };
}
it('returns only an unfenced proposal, never apply or capacity authority', () => {
  const result = assessOfflineContainment(evidence());
  expect(result.status).toBe('proposal');
  expect(result.executable).toBe(false);
  expect(result.fenced).toBe(false);
  expect(result.nativeCleanupConfirmed).toBe(false);
  expect(result.capacityGrant).toBe(false);
  expect(result.requiredPostconditions).toContain('originalPathsUnavailable');
  expect(result.requiredPostconditions).toContain('dispatchClosure');
  expect(result.requiredPostconditions).toContain('controlBindingsInvalidated');
});

it('uses one bound shared proposal through the read-only CLI', async () => {
  const result = await runOfflineRecovery(
    ['audit', '--operation', '33333333-3333-4333-8333-333333333333'],
    {
      observe: (options) =>
        observeOfflineContainment(options, {
          qualify: async () => {},
          collect: async () => evidence(),
        }),
    },
  );
  expect(result.status).toBe('proposal');
  expect(result.facts.units[0].archivePath).toBe(result.facts.archiveRoot + '/symposium');
  expect(result.facts.controls).toHaveLength(2);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.executable).toBe(false);
});
it('rechecks exact completed control phases and the archived unit through trusted inspection callbacks', async () => {
  const plan = assessOfflineContainment(evidence());
  const inspect = vi.fn(async () => {});
  await assertOfflineContainmentBeforeMove(plan, { invalidatedControls: [] }, { inspect });
  await assertOfflineContainmentBeforeMove(plan, { invalidatedControls: ['app'] }, { inspect });
  await assertOfflineContainmentBeforeMove(
    plan,
    { invalidatedControls: ['app', 'vm_supervisor'] },
    { inspect },
  );
  await assertOfflineContainmentContained(plan, { planSha256: plan.sha256 }, { inspect });
  expect(inspect.mock.calls.map((call) => call.slice(1))).toEqual([
    [[], false],
    [['app'], false],
    [['app', 'vm_supervisor'], false],
    [['app', 'vm_supervisor'], true],
  ]);
  expect(plan.capacityGrant).toBe(false);
});
it('refuses changed plans, unknown phases, wrong intents and failed physical observations', async () => {
  const plan = assessOfflineContainment(evidence());
  const inspect = vi.fn(async () => {});
  await expect(
    assertOfflineContainmentBeforeMove({ ...plan, sha256: sha }, {}, { inspect }),
  ).rejects.toThrow();
  await expect(
    assertOfflineContainmentBeforeMove(plan, { invalidatedControls: ['other'] }, { inspect }),
  ).rejects.toThrow();
  await expect(
    assertOfflineContainmentContained(plan, { planSha256: sha }, { inspect }),
  ).rejects.toThrow();
  expect(inspect).not.toHaveBeenCalled();
  inspect.mockRejectedValue(Error('Physical closure no longer current'));
  await expect(assertOfflineContainmentBeforeMove(plan, {}, { inspect })).rejects.toThrow(
    /no longer current/,
  );
});

function replacementProof(phase = 'running') {
  const root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot,
    sourceCommit = 'b'.repeat(40);
  return {
    phase,
    sourceCommit,
    releaseRoot: root + '/releases/' + sourceCommit.slice(0, 12),
    plistPath: root + '/service/com.mitzo.staging.plist',
    plistSha256: 'c'.repeat(64),
    launcherSha256: 'd'.repeat(64),
    expectedProgramArguments: [process.execPath, root + '/service/start.mjs'],
    pid: phase === 'running' ? 1234 : null,
    birth: phase === 'running' ? 'Sun Oct 11 18:00:00 2026' : null,
  };
}
it('binds replacement allowance immutably in a constructor and verifies source every time', async () => {
  const plan = assessOfflineContainment(evidence()),
    proof = replacementProof(),
    verifyCurrentSource = vi.fn(async () => {}),
    inspect = vi.fn(async () => {});
  const owner = createOfflineContainmentInspectionOwner(
    { replacementApp: proof, verifyCurrentSource },
    { inspect },
  );
  proof.pid = 999;
  proof.expectedProgramArguments[1] = '/other/launch';
  await owner.assertContained(plan, { planSha256: plan.sha256 });
  expect(verifyCurrentSource).toHaveBeenCalledOnce();
  expect(inspect.mock.calls[0][3].pid).toBe(1234);
  expect(inspect.mock.calls[0][3].expectedProgramArguments[1]).toBe(
    OFFLINE_CONTAINMENT_TARGET.canonicalRoot + '/service/start.mjs',
  );
  expect(() =>
    createOfflineContainmentInspectionOwner({ replacementApp: replacementProof() }),
  ).toThrow();
});
it.each(['prepared', 'running'])(
  'allows only exact ordinary replacement observation in %s phase',
  (phase) => {
    const proof = replacementProof(phase),
      observation = {
        plistSha256: proof.plistSha256,
        launcherSha256: proof.launcherSha256,
        programArguments: [...proof.expectedProgramArguments],
        job:
          phase === 'running'
            ? { state: 'running', pid: proof.pid, path: proof.plistPath }
            : { state: 'absent' },
        process:
          phase === 'running'
            ? {
                pid: proof.pid,
                birth: proof.birth,
                command:
                  proof.expectedProgramArguments[0] + ' ' + proof.releaseRoot + '/dist/index.js',
              }
            : null,
      };
    expect(() => validateOrdinaryReplacementObservation(proof, observation)).not.toThrow();
    expect(() =>
      validateOrdinaryReplacementObservation(proof, {
        ...observation,
        plistSha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.appPlistSha256,
      }),
    ).toThrow();
    expect(() =>
      validateOrdinaryReplacementObservation(proof, {
        ...observation,
        programArguments: ['/other/node', '/other/start'],
      }),
    ).toThrow();
    if (phase === 'running')
      expect(() =>
        validateOrdinaryReplacementObservation(proof, {
          ...observation,
          process: { ...observation.process, birth: 'changed' },
        }),
      ).toThrow();
    else
      expect(() =>
        validateOrdinaryReplacementObservation(proof, {
          ...observation,
          job: { state: 'running', pid: 1234, path: proof.plistPath },
        }),
      ).toThrow();
  },
);
it.each([
  [
    'source',
    (e) => {
      e.original.sourceCommit = 'b'.repeat(40);
    },
  ],
  [
    'epoch',
    (e) => {
      e.original.controllerGeneration = 2;
    },
  ],
  [
    'birth',
    (e) => {
      e.original.ownerBirthAt = e.currentBoot.startedAt;
    },
  ],
  [
    'captured',
    (e) => {
      e.original.capturedAt = e.currentBoot.startedAt;
    },
  ],
  [
    'scope',
    (e) => {
      e.scope.nativeExecution = 'unknown';
    },
  ],
  [
    'handles',
    (e) => {
      e.proofs.noOpenHandles = { status: 'confirmed' };
    },
  ],
  [
    'alias',
    (e) => {
      e.units[0].mode = 0o755;
    },
  ],
  [
    'future mount',
    (e) => {
      e.futureRoots.push(e.archiveRoot);
    },
  ],
  [
    'receipt',
    (e) => {
      e.retained.retirementReceipt = 'present';
    },
  ],
])('blocks unavailable or contrary %s evidence', (_name, change) => {
  const input = evidence();
  change(input);
  const result = assessOfflineContainment(input);
  expect(result.status).toBe('blocked');
  expect(result.blockedReasons.length).toBeGreaterThan(0);
});
it('never exposes config bodies or raw process diagnostics', () => {
  const input = evidence();
  input.secret = 'credential-value';
  input.diagnostic = 'private output';
  const result = JSON.stringify(assessOfflineContainment(input));
  expect(result).not.toContain('credential-value');
  expect(result).not.toContain('private output');
});
it('qualifies executing source before reading private metadata or probing the host', async () => {
  const collect = vi.fn();
  const result = await observeOfflineContainment(
    {},
    {
      qualify: async () => {
        throw Error('secret diagnostic');
      },
      collect,
    },
  );
  expect(collect).not.toHaveBeenCalled();
  expect(result.blockedReasons).toEqual(['accepted_controller_unavailable']);
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('does not promote incomplete collection to a plan or invoke mutation', async () => {
  const input = evidence();
  input.scope.nativeExecution = 'unknown';
  const mutate = vi.fn();
  const result = await runOfflineRecovery(['plan'], {
    observe: () =>
      observeOfflineContainment({}, { qualify: async () => {}, collect: async () => input }),
    mutate,
  });
  expect(result.status).toBe('blocked');
  expect(mutate).not.toHaveBeenCalled();
  expect(await runOfflineRecovery(['apply'], { observe: mutate })).toMatchObject({
    status: 'blocked',
    blockedReasons: ['unsupported_read_only_command'],
  });
});
it.each(['symlink', 'hardlink'])(
  'rejects a %s in the entire opaque tree without following it',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-offline-observation-'));
    try {
      mkdirSync(join(root, 'opaque'), { mode: 0o700 });
      writeFileSync(join(root, 'opaque/state'), 'opaque bytes', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(join(root, 'opaque/state'), join(root, 'opaque/alias'));
      else linkSync(join(root, 'opaque/state'), join(root, 'outside-alias'));
      expect(() => inspectOpaqueContainmentTree(join(root, 'opaque'))).toThrow(/alias/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('permits only contained public VM metadata mode0644 under private opaque/home ancestors', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-public-vm-mode-')));
  try {
    const opaque = join(root, 'symposium'),
      home = join(opaque, 'home'),
      path = join(home, 'machine.json');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(opaque, 0o700);
    chmodSync(home, 0o700);
    writeFileSync(path, 'public metadata', { mode: 0o644 });
    expect(() => assertPublicVmMetadataPath(path, opaque)).not.toThrow();
    chmodSync(opaque, 0o755);
    expect(() => assertPublicVmMetadataPath(path, opaque)).toThrow();
    chmodSync(opaque, 0o700);
    chmodSync(path, 0o666);
    expect(() => assertPublicVmMetadataPath(path, opaque)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('matches the supplied sanitized installed metadata schema without reading the actual VM', () => {
  const supplied = JSON.parse(
    readFileSync(
      new URL('./fixtures/staging-old-vm-public-metadata.json', import.meta.url),
      'utf8',
    ),
  );
  const machine = JSON.parse(JSON.stringify(supplied.machine)),
    root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  // Only test-operator path/UID fields are translated; measured original bytes remain pinned separately.
  const historicalRoot = machine.SSH.IdentityPath.split('/symposium/home/')[0];
  for (const object of [
    machine.SSH,
    machine.ImagePath,
    machine.AppleHypervisor.Vfkit.VirtualMachine.bootloader,
  ])
    for (const [key, value] of Object.entries(object))
      if (typeof value === 'string' && value.startsWith(historicalRoot + '/'))
        object[key] = root + value.slice(historicalRoot.length);
  machine.HostUser.UID = process.getuid();
  machine.Mounts[0].Source = root;
  machine.Mounts[0].Target = root;
  expect(machine.AppleHypervisor.Vfkit.VirtualMachine.bootloader.kind).toBe('efiBootloader');
  const refs = validateAppleHvContainmentMachine(machine, root);
  expect(refs.disk).toBe(machine.ImagePath.Path);
  expect(supplied.machineSha256).toBe(OFFLINE_CONTAINMENT_NATIVE_TARGET.machineSha256);
  expect(supplied.binaries.map(({ path, sha256 }) => ({ path, sha256 }))).toEqual(
    OFFLINE_CONTAINMENT_TARGET.nativeHelpers.map(({ path, sha256 }) => ({ path, sha256 })),
  );
});
it('returns all seven real component hashes identically after an opaque rename', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-component-manifest-')));
  try {
    const opaque = join(parent, 'symposium');
    for (const part of [
      'home/.config/containers/podman/machine/applehv',
      'home/.local/share/containers/podman/machine/applehv',
      'workspace',
      'state/gateway',
      'settings',
      'service',
    ])
      mkdirSync(join(opaque, part), { recursive: true, mode: 0o700 });
    chmodSync(opaque, 0o700);
    writeFileSync(
      join(opaque, 'home/.config/containers/podman/machine/applehv/mitzo-symposium-staging.json'),
      'synthetic public metadata',
    );
    for (const name of ['mitzo-symposium-staging-arm64.raw', 'efi-bl-mitzo-symposium-staging'])
      writeFileSync(
        join(opaque, 'home/.local/share/containers/podman/machine/applehv', name),
        'opaque bytes',
      );
    writeFileSync(
      join(opaque, 'home/.local/share/containers/podman/machine/machine'),
      'opaque key bytes',
    );
    const before = inspectOpaqueContainmentTree(opaque);
    expect(Object.keys(before.components).sort()).toEqual([
      'diskChain',
      'gateway',
      'home',
      'machine',
      'service',
      'settings',
      'workspace',
    ]);
    const archive = join(parent, 'archived');
    renameSync(opaque, archive);
    const after = inspectOpaqueContainmentTree(archive);
    expect(after.sha256).toBe(before.sha256);
    expect(after.components).toEqual(before.components);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function machineDefinition(root) {
  return {
    Created: '2026-10-06T18:00:58.193882+01:00',
    GvProxy: { Debug: false, MTU: 0, LogFile: '', PidFile: '', SSHPort: 0 },
    HostUser: { Rootful: false, UID: process.getuid(), HostUserModified: false },
    LastUp: '0001-01-01T00:00:00Z',
    Mounts: [
      {
        OriginalInput: '',
        ReadOnly: false,
        Source: root,
        Target: root,
        Tag: '9a7a5dfb0b8eeb3b7a76da1cd731f8174a54',
        Type: 'virtiofs',
        VSockNumber: null,
      },
    ],
    Name: 'mitzo-symposium-staging',
    Resources: { CPUs: 2, DiskSize: 16, Memory: 4096, USBs: [] },
    SSH: {
      IdentityPath: root + '/symposium/home/.local/share/containers/podman/machine/machine',
      Port: 61408,
      RemoteUsername: 'core',
    },
    Version: 1,
    Swap: 0,
    ImagePath: {
      Path:
        root +
        '/symposium/home/.local/share/containers/podman/machine/applehv/mitzo-symposium-staging-arm64.raw',
    },
    AppleHypervisor: {
      Vfkit: {
        LogLevel: 'info',
        Endpoint: 'http://localhost:62752',
        BinaryPath: null,
        VirtualMachine: {
          vcpus: 2,
          memoryBytes: 4294967296,
          bootloader: {
            kind: 'efiBootloader',
            efiVariableStorePath:
              root +
              '/symposium/home/.local/share/containers/podman/machine/applehv/efi-bl-mitzo-symposium-staging',
            createVariableStore: true,
          },
        },
        Rosetta: true,
      },
    },
    Starting: false,
    Rosetta: false,
    Ansible: null,
  };
}
it('closes only the reviewed AppleHV direct raw device and contained private references', () => {
  const root = '/private/test/mitzo-staging';
  const refs = validateAppleHvContainmentMachine(machineDefinition(root), root);
  expect(refs.disk).toContain('/symposium/home/');
  expect(refs.efi).toContain('/symposium/home/');
  expect(refs.ssh).toContain('/symposium/home/');
});
it.each(['efi', 'linuxBootloader', 'macOSBootloader', 'unknown', null])(
  'refuses bootloader kind %s instead of the exact measured vfkit discriminator',
  (kind) => {
    const root = '/private/test/mitzo-staging',
      machine = machineDefinition(root);
    machine.AppleHypervisor.Vfkit.VirtualMachine.bootloader.kind = kind;
    expect(() => validateAppleHvContainmentMachine(machine, root)).toThrow();
  },
);
it.each([
  [
    'extra device',
    (m) => {
      m.AppleHypervisor.Vfkit.VirtualMachine.devices = [{ path: '/external/disk' }];
    },
  ],
  [
    'backing path',
    (m) => {
      m.ImagePath.BackingPath = '/external/disk';
    },
  ],
  [
    'SSH alias',
    (m) => {
      m.SSH.IdentityPath = '/external/key';
    },
  ],
  [
    'helper override',
    (m) => {
      m.AppleHypervisor.Vfkit.BinaryPath = '/external/vfkit';
    },
  ],
  [
    'extra mount',
    (m) => {
      m.Mounts.push({ ...m.Mounts[0], Source: '/external' });
    },
  ],
  [
    'USB',
    (m) => {
      m.Resources.USBs = ['host-device'];
    },
  ],
  [
    'alternate hypervisor',
    (m) => {
      m.QEMUHypervisor = {};
    },
  ],
  [
    'unknown top level',
    (m) => {
      m.ExternalRuntime = '/external';
    },
  ],
])('rejects %s before storage or runtime inspection', (_name, change) => {
  const root = '/private/test/mitzo-staging',
    m = machineDefinition(root);
  change(m);
  expect(() => validateAppleHvContainmentMachine(m, root)).toThrow();
});
it.each(['514649fb', '4b444d56', '7668647866696c65'])(
  'rejects an alternate disk container header %s',
  (hex) => {
    expect(() => assertDirectRawDiskHeader(Buffer.from(hex, 'hex'), Buffer.alloc(512))).toThrow();
  },
);
it('rejects VHD footer and never guesses handle or mount absence from failure', () => {
  expect(() => assertDirectRawDiskHeader(Buffer.alloc(512), Buffer.from('conectix'))).toThrow();
  expect(() => assertScopedNoOpenHandles({ status: 1, stdout: '', stderr: '' })).not.toThrow();
  expect(() =>
    assertScopedNoOpenHandles({ status: 1, stdout: '', stderr: 'permission denied' }),
  ).toThrow();
  expect(() =>
    assertScopedNoOpenHandles({
      status: 0,
      stdout: 'p42\nn/private/test/mitzo-staging/symposium/file\n',
      stderr: '',
    }),
  ).toThrow();
  expect(() =>
    assertNoScopedMountAliases('/dev/disk3 on /System/Volumes/Data (apfs)\n', [
      '/private/test/mitzo-staging/symposium',
    ]),
  ).not.toThrow();
  expect(() =>
    assertNoScopedMountAliases('/private/test/mitzo-staging/symposium on /alias (bind)\n', [
      '/private/test/mitzo-staging/symposium',
    ]),
  ).toThrow();
  expect(() =>
    assertNoScopedMountAliases(
      '/dev/disk3 on /private/test/mitzo-staging/symposium/mounted (apfs)\n',
      ['/private/test/mitzo-staging/symposium'],
    ),
  ).toThrow();
  expect(() =>
    assertNoScopedMountAliases('unknown table format', ['/private/test/mitzo-staging/symposium']),
  ).toThrow();
});

it('selects stock Podman by kind after shared canonical sorting and compares component maps canonically', () => {
  const proposal = assessOfflineContainment(evidence());
  expect(proposal.facts.nativeHelpers[0].kind).toBe('gvproxy');
  expect(offlineContainmentNativeHelper(proposal.facts, 'podman').path).toBe(
    OFFLINE_CONTAINMENT_TARGET.nativeHelpers.find((pin) => pin.kind === 'podman').path,
  );
  const unit = proposal.facts.units[0],
    manifest = {
      sha256: unit.manifestSha256,
      components: Object.fromEntries(Object.entries(unit.components).reverse()),
    };
  expect(() => assertOpaqueContainmentManifest(manifest, unit)).not.toThrow();
  expect(() =>
    assertOpaqueContainmentManifest(
      { ...manifest, components: { ...manifest.components, machine: 'b'.repeat(64) } },
      unit,
    ),
  ).toThrow();
});
