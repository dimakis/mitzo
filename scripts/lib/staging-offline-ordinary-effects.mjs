import process from 'node:process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, basename } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createOfflineOrdinaryRestorationPlan } from './staging-offline-ordinary-restore.mjs';
import { offlineContainmentDigest } from './staging-offline-containment-contract.mjs';
import {
  inspectOpaquePreservationTree,
  classifyCanonicalJobAbsence,
} from './staging-offline-containment-observation.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const same = (a, b) => offlineContainmentDigest(a) === offlineContainmentDigest(b);
const encode = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const environment = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' });
function requireEffect(condition) {
  if (!condition) throw Error('Ordinary restoration evidence changed; retain original guard');
}
function fileTools(io) {
  const exists = (path) => {
    try {
      io.lstatSync(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const directory = (path) => {
    const stat = io.lstatSync(path);
    requireEffect(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid() &&
        !(stat.mode & 0o077) &&
        io.realpathSync(path) === path,
    );
    return stat;
  };
  const read = (path, privateFile = true) => {
    const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try {
      const stat = io.fstatSync(fd);
      requireEffect(
        stat.isFile() &&
          stat.uid === process.getuid() &&
          stat.nlink === 1 &&
          !(stat.mode & (privateFile ? 0o077 : 0o022)) &&
          stat.size <= 262144 &&
          io.realpathSync(path) === path,
      );
      const bytes = io.readFileSync(fd);
      const after = io.fstatSync(fd);
      requireEffect(
        after.ino === stat.ino &&
          after.dev === stat.dev &&
          after.size === stat.size &&
          after.mtimeMs === stat.mtimeMs &&
          bytes.length === stat.size,
      );
      return { bytes, stat };
    } finally {
      io.closeSync(fd);
    }
  };
  const sync = (path) => {
    const fd = io.openSync(path, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
    try {
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  };
  const ensure = (path, base) => {
    requireEffect(path === base || path.startsWith(base + '/'));
    if (path !== base) ensure(dirname(path), base);
    if (!exists(path)) {
      io.mkdirSync(path, { mode: 0o700 });
      sync(dirname(path));
    }
    directory(path);
  };
  const exclusive = (path, bytes, mode = 0o600) => {
    directory(dirname(path));
    const fd = io.openSync(
      path,
      io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_WRONLY | io.constants.O_NOFOLLOW,
      mode,
    );
    try {
      io.writeFileSync(fd, bytes);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    sync(dirname(path));
  };
  return {
    exists,
    directory,
    read,
    sync,
    ensure,
    exclusive,
    json: (path) => JSON.parse(read(path).bytes.toString('utf8')),
  };
}
function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function shell(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
function bundle(root, source, receipt, containmentPlanSha256, receiptSha256, tools, nodePath) {
  const ordinaryReceipt = {
    label: 'com.mitzo.staging',
    port: 3190,
    bind: '127.0.0.1',
    workspace: join(root, 'workspace'),
    release: source,
    sourceCommit: receipt.sourceCommit,
    sourceTree: receipt.sourceTree,
    compiledArtifacts: receipt.compiledArtifacts,
    dependencyFingerprint: receipt.dependencyFingerprint,
  };
  const nodeArgs = Object.freeze([nodePath, join(root, 'service/start.mjs')]);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.mitzo.staging</string><key>ProgramArguments</key><array>${nodeArgs.map((arg) => '<string>' + xml(arg) + '</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(homedir())}</string><key>PATH</key><string>/usr/bin:/bin</string><key>TMPDIR</key><string>/private/tmp</string><key>LANG</key><string>C</string></dict><key>WorkingDirectory</key><string>${xml(source)}</string><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>${xml(join(root, 'state/server.stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'state/server.stderr.log'))}</string></dict></plist>\n`;
  const template = tools.read(
    join(source, 'scripts/lib/staging-launcher-template.mjs'),
    false,
  ).bytes;
  for (const flag of [
    'MITZO_OPENSHELL_ENABLED',
    'MITZO_CODEX_ENABLED',
    'MITZO_CONNECTIONS_ENABLED',
  ])
    requireEffect(template.toString('utf8').includes(flag + ": '0'"));
  const output = {
    'service/start.mjs': template,
    'service/control-lib/staging-files.mjs': tools.read(
      join(source, 'scripts/lib/staging-files.mjs'),
      false,
    ).bytes,
    'service/control-lib/staging-operations.mjs': tools.read(
      join(source, 'scripts/lib/staging-operations.mjs'),
      false,
    ).bytes,
    'service/release-receipt.json': encode(ordinaryReceipt),
    'service/topology.json': receiptSha256
      ? encode({
          version: 1,
          mode: 'ordinary',
          sourceCommit: receipt.sourceCommit,
          containmentPlanSha256,
          containmentReceiptSha256: receiptSha256,
        })
      : undefined,
    'service/com.mitzo.staging.plist': Buffer.from(plist),
    'bin/mitzo-staging': Buffer.from(
      `#!/bin/sh\nexec ${shell(nodePath)} ${shell(join(source, 'scripts/staging.mjs'))} "$@"\n`,
    ),
  };
  return { output, nodeArgs, ordinaryReceipt };
}

/** Read-only materialization of prospective ordinary state. The app plist is
 * expected absent AFTER its already-bound native containment move. Topology
 * bytes derive only from that operation's later verified receipt, never a guess. */
export async function collectOfflineOrdinaryRestorationFacts(
  { containmentPlan, sourceCommit, assertAcceptedPreparedSource },
  deps = {},
) {
  requireEffect(
    typeof assertAcceptedPreparedSource === 'function' &&
      /^[a-f0-9]{40}$/.test(sourceCommit) &&
      sha.test(containmentPlan?.sha256),
  );
  const io = deps.io ?? fs,
    tools = fileTools(io),
    root = containmentPlan.facts.canonicalRoot,
    archiveRoot = containmentPlan.facts.archiveRoot,
    release = join(root, 'releases', sourceCommit.slice(0, 12)),
    nodePath = deps.nodePath ?? io.realpathSync(process.execPath);
  await assertAcceptedPreparedSource({ canonicalRoot: root, release, sourceCommit });
  const receiptBytes = tools.read(join(release, 'staging-release.json')).bytes,
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  requireEffect(
    receipt.sourceCommit === sourceCommit &&
      /^[a-f0-9]{40}$/.test(receipt.sourceTree) &&
      sha.test(receipt.dependencyFingerprint),
  );
  const material = bundle(
    root,
    release,
    receipt,
    containmentPlan.sha256,
    undefined,
    tools,
    nodePath,
  );
  const inspect = deps.inspectTree ?? inspectOpaquePreservationTree;
  const preservation = ['home', 'workspace', 'state', 'settings'].map((kind) => {
    const path = join(root, kind),
      stat = tools.directory(path);
    requireEffect((stat.mode & 0o777) === 0o700);
    return {
      kind,
      path,
      archivePath: join(archiveRoot, 'ordinary-prior', kind),
      manifestSha256: inspect(path).sha256,
      uid: stat.uid,
      mode: stat.mode & 0o777,
    };
  });
  const controls = Object.entries(material.output).map(([name, bytes]) => {
    const path = join(root, name);
    let prior = { state: 'absent' };
    if (name !== 'service/com.mitzo.staging.plist' && tools.exists(path)) {
      const selected = tools.read(path, false);
      prior = {
        state: 'present',
        sha256: hash(selected.bytes),
        uid: selected.stat.uid,
        mode: selected.stat.mode & 0o777,
      };
    }
    return {
      path,
      archivePath: join(archiveRoot, 'ordinary-prior-controls', name),
      prior,
      nextSha256: bytes ? hash(bytes) : 'derived_containment_topology',
    };
  });
  await assertAcceptedPreparedSource({ canonicalRoot: root, release, sourceCommit });
  return {
    version: 1,
    canonicalRoot: root,
    operatorUid: process.getuid(),
    archiveRoot,
    containment: {
      planSha256: containmentPlan.sha256,
      classification: 'contained_offline_native_cleanup_unconfirmed',
      originalRegistryState: 'retirement_uncertain',
    },
    source: {
      sourceCommit,
      acceptedMainBaseline: sourceCommit,
      sourceTree: receipt.sourceTree,
      release,
      controllerReceiptSha256: hash(receiptBytes),
      compiledArtifactsSha256: offlineContainmentDigest(receipt.compiledArtifacts),
      dependencyFingerprint: receipt.dependencyFingerprint,
    },
    installation: {
      launcherSha256: hash(material.output['service/start.mjs']),
      controllerManifestSha256: offlineContainmentDigest(
        controls
          .map(({ path, nextSha256 }) => ({ path, nextSha256 }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      ),
      registrationSha256: hash(material.output['service/com.mitzo.staging.plist']),
      controlFiles: controls,
    },
    preservation,
  };
}

/** Concrete preservation/installation/job effects. Fresh source qualification,
 * native containment and lock control remain original-parent capabilities.
 * All test effects are injected; this factory performs no work at construction. */
export function createOfflineOrdinaryEffects(
  {
    plan: selected,
    verifySource,
    verifyContainment,
    guardCapability,
    continuation,
    assertAuthorityCurrent,
    initialContainmentReceiptSha256,
  },
  deps = {},
) {
  const plan = createOfflineOrdinaryRestorationPlan(selected.facts),
    facts = plan.facts,
    root = facts.canonicalRoot,
    archive = facts.archiveRoot;
  requireEffect(
    same(plan, selected) &&
      typeof verifySource === 'function' &&
      typeof verifyContainment === 'function' &&
      typeof assertAuthorityCurrent === 'function',
  );
  const io = deps.io ?? fs,
    tools = fileTools(io),
    inspect = deps.inspectTree ?? inspectOpaquePreservationTree,
    run = deps.run ?? spawnSync,
    nodePath = deps.nodePath ?? io.realpathSync(process.execPath);
  const intentPath = join(archive, 'ordinary-restore-intent.json'),
    completionPath = join(archive, 'ordinary-completed.json'),
    startPath = join(archive, 'ordinary-start-attempt.json'),
    guardPath = join(root, 'service/deployment.lock');
  requireEffect(
    initialContainmentReceiptSha256 === undefined || sha.test(initialContainmentReceiptSha256),
  );
  // Seed only from the original completed native transaction capability.
  // The callback rechecks its private receipt bytes before any admission.
  let receiptSha256 = initialContainmentReceiptSha256,
    replacement,
    originalJob;
  const current = (context) => {
    assertAuthorityCurrent();
    context?.assertCurrent();
  };
  const capability = () => {
    const value = guardCapability ?? continuation;
    const cap = typeof value === 'function' ? value() : value;
    requireEffect(
      cap &&
        typeof cap.assertOwnedGuard === 'function' &&
        typeof cap.bindOrdinaryGuard === 'function' &&
        typeof cap.completeOrdinaryGuard === 'function',
    );
    return cap;
  };
  const source = () => {
    const bytes = tools.read(join(facts.source.release, 'staging-release.json')).bytes,
      r = JSON.parse(bytes.toString('utf8'));
    requireEffect(
      hash(bytes) === facts.source.controllerReceiptSha256 &&
        r.sourceCommit === facts.source.sourceCommit &&
        r.sourceTree === facts.source.sourceTree &&
        r.dependencyFingerprint === facts.source.dependencyFingerprint &&
        offlineContainmentDigest(r.compiledArtifacts) === facts.source.compiledArtifactsSha256,
    );
    return r;
  };
  const material = () =>
    bundle(
      root,
      facts.source.release,
      source(),
      facts.containment.planSha256,
      receiptSha256,
      tools,
      nodePath,
    );
  const guard = () => {
    const value = tools.json(guardPath);
    requireEffect(
      value.operation === basename(archive) &&
        value.planSha256 === facts.containment.planSha256 &&
        value.mode === 'offline-native-containment',
    );
    return value;
  };
  const original = (file) => {
    if (file.prior.state === 'absent') {
      requireEffect(!tools.exists(file.path));
      return;
    }
    const value = tools.read(file.path, false);
    requireEffect(
      hash(value.bytes) === file.prior.sha256 &&
        value.stat.uid === file.prior.uid &&
        (value.stat.mode & 0o777) === file.prior.mode,
    );
    return value;
  };
  const guardOwned = (context) => {
    current(context);
    capability().assertOwnedGuard(plan);
    current(context);
  };
  const command = (program, args, allowFailure = false) => {
    const result = run(program, args, {
      env: environment,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      shell: false,
    });
    requireEffect(!result.error && !result.signal && (allowFailure || result.status === 0));
    return result;
  };
  const installed = () => {
    requireEffect(sha.test(receiptSha256));
    const built = material();
    for (const file of facts.installation.controlFiles) {
      const name = relative(root, file.path),
        expected = built.output[name];
      requireEffect(expected && hash(tools.read(file.path, false).bytes) === hash(expected));
    }
    const settings = tools.json(join(root, 'settings/operator.json'));
    requireEffect(
      Object.keys(settings).sort().join() === 'AUTH_PASSPHRASE,AUTH_SECRET' &&
        typeof settings.AUTH_PASSPHRASE === 'string' &&
        settings.AUTH_PASSPHRASE.length >= 32 &&
        typeof settings.AUTH_SECRET === 'string' &&
        settings.AUTH_SECRET.length >= 64 &&
        same(tools.json(join(root, 'settings/account-profiles.json')), []),
    );
    return built;
  };
  const readJob = () => {
    const result = command('/bin/launchctl', [
        'print',
        'gui/' + process.getuid() + '/com.mitzo.staging',
      ]),
      text = result.stdout;
    const pid = Number(text.match(/^\s*pid = (\d+)$/m)?.[1]),
      path = text.match(/^\s*path = (.+)$/m)?.[1];
    requireEffect(Number.isSafeInteger(pid) && pid > 1 && path === plan.registration.path);
    const birth = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']).stdout.trim();
    const cwd = command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .stdout.split('\n')
      .filter((line) => line.startsWith('n'));
    requireEffect(birth && cwd.length === 1);
    return { pid, birth, cwd: cwd[0].slice(1) };
  };
  const portPids = (port) => {
    const result = command('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], true);
    if (result.status === 1 && !(result.stdout ?? '').trim()) return [];
    requireEffect(result.status === 0);
    const values = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
    requireEffect(values.every((pid) => Number.isSafeInteger(pid) && pid > 1));
    return values;
  };
  const effects = {
    async assertAcceptedPreparedSource(_, context) {
      current(context);
      await verifySource(plan);
      current(context);
      source();
    },
    async assertNativeContained(_, context) {
      current(context);
      const proof = await verifyContainment(plan);
      current(context);
      requireEffect(
        sha.test(proof?.receiptSha256) && (!receiptSha256 || receiptSha256 === proof.receiptSha256),
      );
      receiptSha256 = proof.receiptSha256;
      return { receiptSha256 };
    },
    async assertOriginalOrdinaryScope(_, context) {
      current(context);
      requireEffect(
        classifyCanonicalJobAbsence(
          command(
            '/bin/launchctl',
            ['print', 'gui/' + process.getuid() + '/com.mitzo.staging'],
            true,
          ),
          process.getuid(),
        ).status === 'absent' && portPids(3190).length === 0,
      );
    },
    async assertGuardOwnership(_, context) {
      guardOwned(context);
    },
    async assertOriginalUnit(unit, _, context) {
      current(context);
      const stat = tools.directory(unit.path);
      requireEffect(
        (stat.mode & 0o777) === unit.mode && inspect(unit.path).sha256 === unit.manifestSha256,
      );
    },
    async writeDurableIntent(intent, _, context) {
      guardOwned(context);
      tools.exclusive(intentPath, encode(intent));
      current(context);
      capability().bindOrdinaryGuard(
        {
          planSha256: plan.sha256,
          intentPath,
          intentSha256: offlineContainmentDigest(intent),
          target: facts.source.sourceCommit,
        },
        plan,
      );
    },
    async snapshotControl(file, _, context) {
      guardOwned(context);
      const value = original(file);
      tools.ensure(dirname(file.archivePath), archive);
      current(context);
      if (value) tools.exclusive(file.archivePath, value.bytes);
      tools.exclusive(file.archivePath + '.metadata.json', encode(file.prior));
    },
    async assertControlSnapshot(file, _, context) {
      current(context);
      requireEffect(same(tools.json(file.archivePath + '.metadata.json'), file.prior));
      if (file.prior.state === 'present')
        requireEffect(hash(tools.read(file.archivePath).bytes) === file.prior.sha256);
      else requireEffect(!tools.exists(file.archivePath));
    },
    async preserveUnit(unit, _, context) {
      guardOwned(context);
      await effects.assertOriginalUnit(unit, plan, context);
      tools.ensure(dirname(unit.archivePath), archive);
      requireEffect(
        !tools.exists(unit.archivePath) &&
          tools.directory(unit.path).dev === tools.directory(dirname(unit.archivePath)).dev,
      );
      current(context);
      io.renameSync(unit.path, unit.archivePath);
      tools.sync(dirname(unit.path));
      tools.sync(dirname(unit.archivePath));
    },
    async assertPreservedUnit(unit, _, context) {
      current(context);
      requireEffect(
        !tools.exists(unit.path) && inspect(unit.archivePath).sha256 === unit.manifestSha256,
      );
      tools.directory(unit.archivePath);
    },
    async createFreshDirectory(input, _, context) {
      guardOwned(context);
      requireEffect(
        facts.preservation.some((unit) => unit.path === input.path) &&
          input.empty === true &&
          input.mode === 0o700 &&
          !tools.exists(input.path),
      );
      current(context);
      io.mkdirSync(input.path, { mode: 0o700 });
      tools.sync(dirname(input.path));
      requireEffect(io.readdirSync(input.path).length === 0);
    },
    async writeFreshSettings(input, _, context) {
      guardOwned(context);
      requireEffect(
        input.mode === 0o600 &&
          same(input.accountProfiles, []) &&
          Object.keys(input.operator).sort().join() === 'AUTH_PASSPHRASE,AUTH_SECRET' &&
          typeof input.operator.AUTH_PASSPHRASE === 'string' &&
          input.operator.AUTH_PASSPHRASE.length >= 32 &&
          typeof input.operator.AUTH_SECRET === 'string' &&
          input.operator.AUTH_SECRET.length >= 64,
      );
      tools.exclusive(join(root, 'settings/operator.json'), encode(input.operator));
      tools.exclusive(join(root, 'settings/account-profiles.json'), encode([]));
    },
    async installOrdinaryController(_, context) {
      guardOwned(context);
      const built = material();
      requireEffect(
        offlineContainmentDigest(
          facts.installation.controlFiles
            .map(({ path, nextSha256 }) => ({ path, nextSha256 }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        ) === facts.installation.controllerManifestSha256,
      );
      const preparedReplacement = Object.freeze({
        planSha256: plan.sha256,
        sourceCommit: facts.source.sourceCommit,
        release: facts.source.release,
        plistPath: plan.registration.path,
        plistSha256: facts.installation.registrationSha256,
        launcherPath: join(root, 'service/start.mjs'),
        launcherSha256: facts.installation.launcherSha256,
        nodePath,
        nodeArgs: built.nodeArgs,
      });
      for (const file of [...facts.installation.controlFiles].sort(
        (a, b) =>
          Number(a.path === plan.registration.path) - Number(b.path === plan.registration.path),
      )) {
        const bytes = built.output[relative(root, file.path)];
        requireEffect(
          bytes &&
            (file.nextSha256 === 'derived_containment_topology' || hash(bytes) === file.nextSha256),
        );
        await effects.assertControlSnapshot(file, plan, context);
        original(file);
        tools.ensure(dirname(file.path), root);
        const pending = file.path + '.ordinary-' + randomUUID();
        current(context);
        tools.exclusive(
          pending,
          bytes,
          file.path === join(root, 'bin/mitzo-staging') ? 0o700 : 0o600,
        );
        original(file);
        guardOwned(context);
        io.renameSync(pending, file.path);
        if (file.path === plan.registration.path) replacement = preparedReplacement;
        tools.sync(dirname(file.path));
      }
      installed();
    },
    async assertInstalledOrdinary(_, context) {
      guardOwned(context);
      installed();
    },
    async writeStartAttempt(intent, _, context) {
      guardOwned(context);
      requireEffect(same(tools.json(intentPath), intent));
      tools.exclusive(startPath, encode(intent));
    },
    async writeLaunchPermit(permit, _, context) {
      guardOwned(context);
      const held = guard();
      requireEffect(
        held.id === permit.id &&
          held.target === permit.target &&
          permit.target === facts.source.sourceCommit &&
          Number.isFinite(permit.expiresAt) &&
          permit.expiresAt > Date.now() &&
          permit.expiresAt <= Date.now() + 15000,
      );
      requireEffect(tools.exists(startPath));
      tools.exclusive(join(root, 'service/launch-permit.json'), encode(permit));
    },
    async bootstrapCanonical(_, __, context) {
      guardOwned(context);
      installed();
      await effects.assertOriginalOrdinaryScope(plan, context);
      current(context);
      command('/bin/launchctl', ['bootstrap', 'gui/' + process.getuid(), plan.registration.path]);
    },
    async kickstartCanonical(input, _, context) {
      guardOwned(context);
      requireEffect(input.label === 'com.mitzo.staging' && input.force === false);
      installed();
      current(context);
      command('/bin/launchctl', ['kickstart', 'gui/' + process.getuid() + '/com.mitzo.staging']);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        current(context);
        try {
          originalJob = readJob();
          return { pid: originalJob.pid, birth: originalJob.birth };
        } catch {
          await (deps.wait ?? wait)(100);
        }
      }
      throw Error('Original ordinary startup unconfirmed; retain guard');
    },
    async verifyCanonical(_, context) {
      guardOwned(context);
      installed();
      requireEffect(originalJob);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        current(context);
        source();
        const job = readJob();
        requireEffect(
          job.pid === originalJob.pid &&
            job.birth === originalJob.birth &&
            job.cwd === facts.source.release,
        );
        const processCommand = command('/bin/ps', [
          '-p',
          String(job.pid),
          '-o',
          'command=',
        ]).stdout.trim();
        let status;
        if (processCommand === nodePath + ' ' + join(facts.source.release, 'dist/index.js')) {
          try {
            status = (
              await (deps.fetch ?? globalThis.fetch)('http://127.0.0.1:3190', {
                signal: globalThis.AbortSignal.timeout(2000),
                redirect: 'error',
              })
            ).status;
          } catch {
            /* Readiness may precede listener startup. */
          }
        }
        current(context);
        const latest = readJob();
        requireEffect(same(latest, job));
        const listeners = portPids(3190);
        requireEffect(
          listeners.length === 0 || (listeners.length === 1 && listeners[0] === job.pid),
        );
        if (status === 200 && listeners.length === 1) {
          replacement = Object.freeze({ ...replacement, originalJob: Object.freeze({ ...job }) });
          return {
            ...job,
            label: 'com.mitzo.staging',
            portPids: listeners,
            protectedPids: [...portPids(3100), ...portPids(3101)],
            httpStatus: status,
            registrationSha256: hash(tools.read(plan.registration.path).bytes),
            providerProfiles: 0,
            nativeEnabled: false,
            codexEnabled: false,
            connectionsEnabled: false,
          };
        }
        await (deps.wait ?? wait)(250);
      }
      throw Error('Original ordinary readiness unconfirmed; retain guard');
    },
    async writeCompletion(receipt, _, context) {
      guardOwned(context);
      requireEffect(
        receipt.planSha256 === plan.sha256 &&
          receipt.containmentSha256 === receiptSha256 &&
          receipt.pid === originalJob?.pid &&
          receipt.birth === originalJob?.birth,
      );
      tools.exclusive(completionPath, encode(receipt));
    },
    async completeGuard(receipt, _, context) {
      guardOwned(context);
      requireEffect(same(tools.json(completionPath), receipt));
      await capability().completeOrdinaryGuard(receipt, plan);
      current(context);
    },
    getReplacementProof() {
      if (!replacement) return undefined;
      assertAuthorityCurrent();
      installed();
      return replacement;
    },
    assertContinuationSync(nativePlan, ordinaryPlan, phase, payload) {
      assertAuthorityCurrent();
      requireEffect(
        nativePlan.sha256 === facts.containment.planSha256 &&
          (!ordinaryPlan || same(ordinaryPlan, plan)),
      );
      source();
      const held = guard();
      const nativeIntentPath = archive + '.intent.json',
        nativeIntent = tools.json(nativeIntentPath);
      requireEffect(
        held.intentPath === nativeIntentPath &&
          nativeIntent.version === 1 &&
          nativeIntent.operation === basename(archive) &&
          nativeIntent.planSha256 === facts.containment.planSha256 &&
          offlineContainmentDigest(nativeIntent) === held.intentSha256 &&
          sha.test(receiptSha256) &&
          hash(tools.read(join(archive, 'containment-receipt.json')).bytes) === receiptSha256,
      );
      if (phase === 'bind') {
        requireEffect(
          payload.planSha256 === plan.sha256 &&
            payload.target === facts.source.sourceCommit &&
            payload.intentPath === intentPath &&
            payload.intentSha256 === offlineContainmentDigest(tools.json(intentPath)),
        );
      } else if (held.continuationPlanSha256) {
        requireEffect(
          held.continuationPlanSha256 === plan.sha256 &&
            held.target === facts.source.sourceCommit &&
            held.continuationIntentPath === intentPath &&
            held.continuationIntentSha256 === offlineContainmentDigest(tools.json(intentPath)) &&
            held.containmentReceiptSha256 === receiptSha256,
        );
        const ordinaryIntent = tools.json(intentPath);
        requireEffect(
          ordinaryIntent.version === 1 &&
            ordinaryIntent.operation === basename(archive) &&
            ordinaryIntent.mode === 'offline-ordinary-restoration' &&
            ordinaryIntent.planSha256 === plan.sha256 &&
            ordinaryIntent.containmentSha256 === receiptSha256 &&
            ordinaryIntent.target === facts.source.sourceCommit,
        );
      }
      if (phase === 'replacement') {
        requireEffect(replacement);
        installed();
        requireEffect(payload.continuationPlanSha256 === plan.sha256);
      }
      requireEffect(['owned', 'bind', 'retained', 'replacement'].includes(phase));
      return true;
    },
    assertGuardContinuation(nativePlan, ordinaryPlan, phase, payload) {
      if (phase !== 'complete')
        return effects.assertContinuationSync(nativePlan, ordinaryPlan, phase, payload);
      return (async () => {
        effects.assertContinuationSync(nativePlan, ordinaryPlan, 'owned', guard());
        requireEffect(same(tools.json(completionPath), payload));
        await effects.assertAcceptedPreparedSource(plan);
        await effects.assertNativeContained(plan);
        const proof = await effects.verifyCanonical(plan);
        requireEffect(
          proof.httpStatus === 200 && proof.pid === payload.pid && proof.birth === payload.birth,
        );
        assertAuthorityCurrent();
        return true;
      })();
    },
  };
  return Object.freeze(effects);
}
