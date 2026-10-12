import process from 'node:process';
import { userInfo } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import {
  lstatSync,
  realpathSync,
  readFileSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
const fail = () =>
  Error('Exact fresh canonical registered native launcher unavailable; retain original evidence');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const xml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
/** Code-owned registration template. Public fields/bytes grant no guard, native
 * capacity or permission to install/start this job. Exactly one canonical label. */
export function createContainedNativeLauncherPlist(spec) {
  const { root, allocation, sourceCommit, sourceRoot, node, bootstrapSha256 } = spec;
  if (
    root !== join(userInfo().homedir, '.local/share/mitzo-staging') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(allocation ?? '') ||
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? '') ||
    sourceRoot !== join(root, 'releases', sourceCommit.slice(0, 12)) ||
    !isAbsolute(node) ||
    /\p{C}/u.test(node) ||
    !/^[a-f0-9]{64}$/.test(bootstrapSha256 ?? '')
  )
    throw fail();
  const bootstrapPath = join(root, 'service/native-dispositions', allocation, 'bootstrap.json');
  const nativeRoot = join(root, 'symposium/allocations', allocation);
  const fields = {
    Label: 'com.mitzo.staging',
    ProgramArguments: [
      node,
      join(sourceRoot, 'scripts/start-contained-native-staging.mjs'),
      bootstrapPath,
      '--expected-bootstrap',
      bootstrapSha256,
    ],
    EnvironmentVariables: {
      NODE_OPTIONS: '--max-old-space-size=1024',
      NODE_PATH: '',
      DOTENV_CONFIG_PATH: '/dev/null',
    },
    WorkingDirectory: sourceRoot,
    StandardOutPath: join(nativeRoot, 'service/owner.stdout.log'),
    StandardErrorPath: join(nativeRoot, 'service/owner.stderr.log'),
    KeepAlive: false,
    RunAtLoad: false,
    ExitTimeOut: 180,
  };
  const render = (value) =>
    Array.isArray(value)
      ? '<array>' + value.map(render).join('') + '</array>'
      : typeof value === 'boolean'
        ? `<${value}/>`
        : typeof value === 'number'
          ? '<integer>' + value + '</integer>'
          : typeof value === 'object'
            ? '<dict>' +
              Object.entries(value)
                .map(([key, v]) => '<key>' + xml(key) + '</key>' + render(v))
                .join('') +
              '</dict>'
            : '<string>' + xml(value) + '</string>';
  const bytes =
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">' + render(fields) + '</plist>\n';
  return freeze({
    spec: { ...spec },
    bootstrapPath,
    nativeRoot,
    fields,
    bytes,
    sha256: hash(bytes),
  });
}
/** Metadata assertion only. The actual accepted observer below independently
 * obtains launchctl/plutil/process observations; JSON cannot become that observer. */
export function assertContainedNativeLauncherObservation(expected, o) {
  if (
    !o ||
    o.pid !== process.pid ||
    typeof o.birth !== 'string' ||
    !o.birth.trim() ||
    o.cwd !== expected.spec.sourceRoot ||
    o.parentPid !== 1 ||
    o.plistSha256 !== expected.sha256 ||
    o.bootstrapSha256 !== expected.spec.bootstrapSha256 ||
    digest(o.plist) !== digest(expected.fields) ||
    o.job?.path !== join(expected.spec.root, 'service/com.mitzo.staging.plist') ||
    o.job.pid !== process.pid ||
    o.job.runs !== 1 ||
    o.job.state !== 'running'
  )
    throw fail();
  return Object.freeze({
    pid: process.pid,
    birth: o.birth,
    sourceRoot: expected.spec.sourceRoot,
    registrationSha256: expected.sha256,
  });
}
function privateBytes(path, max = 512 * 1024) {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      s.size > max ||
      realpathSync(path) !== path
    )
      throw fail();
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
const command = (program, args) => {
  const p = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  if (p.error || p.signal || p.status !== 0 || p.stderr) throw fail();
  return p.stdout.trim();
};
/** Actual read-only native launcher enrollment. The same process must be launchd's
 * original first-run PID with matching birth, cwd, exact source argv and private
 * registration bytes. An old label, TCP refusal or installation receipt cannot
 * implement this guard capability. No synthetic effects are accepted here. */
export function createContainedNativeRegisteredLauncherObserver(spec) {
  const expected = createContainedNativeLauncherPlist(spec);
  if (process.platform !== 'darwin' || spec.node !== process.execPath) throw fail();
  let original;
  return Object.freeze({
    expected,
    observe() {
      const plistPath = join(spec.root, 'service/com.mitzo.staging.plist');
      const bootstrap = privateBytes(expected.bootstrapPath),
        plistBytes = privateBytes(plistPath, 32768);
      const plist = JSON.parse(
        command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]),
      );
      const jobText = command('/bin/launchctl', [
        'print',
        `gui/${process.getuid()}/com.mitzo.staging`,
      ]);
      const field = (name) =>
        jobText.match(new RegExp('^\\s*' + name + ' = (.+)$', 'm'))?.[1]?.trim();
      const cwd = command('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-d', 'cwd', '-Fn'])
        .split('\n')
        .filter((line) => line.startsWith('n'));
      if (cwd.length !== 1) throw fail();
      const observation = assertContainedNativeLauncherObservation(expected, {
        pid: process.pid,
        birth: command('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']),
        parentPid: Number(command('/bin/ps', ['-p', String(process.pid), '-o', 'ppid='])),
        cwd: cwd[0].slice(1),
        plist,
        plistSha256: hash(plistBytes),
        bootstrapSha256: hash(bootstrap),
        job: {
          path: field('path'),
          pid: Number(field('pid')),
          runs: Number(field('runs')),
          state: field('state'),
        },
      });
      if (original && digest(observation) !== digest(original)) throw fail();
      original ??= observation;
      if (
        hash(privateBytes(expected.bootstrapPath)) !== spec.bootstrapSha256 ||
        hash(privateBytes(plistPath, 32768)) !== expected.sha256
      )
        throw fail();
      return observation;
    },
  });
}
