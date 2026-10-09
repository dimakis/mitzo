import process from 'node:process';
import { createHash } from 'node:crypto';
import { join, isAbsolute, normalize } from 'node:path';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
} from 'node:fs';

const maxSize = 256 * 1024 * 1024;
const hash = (data) => createHash('sha256').update(data).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s) => ({ dev: s.dev, ino: s.ino, uid: s.uid, gid: s.gid, mode: s.mode });

function privateDirectory(path) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o7777) !== 0o700 ||
    realpathSync(path) !== path
  )
    throw Error('Private unaliased program directory required');
  return identity(s);
}
function programDirectories(root) {
  if (!isAbsolute(root) || normalize(root) !== root) throw Error('Canonical program root required');
  return { root: privateDirectory(root), symposium: privateDirectory(join(root, 'symposium')) };
}
function readProgram(path, privateCopy = false) {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw Error('Unaliased program required');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      s.mode & 0o7022 ||
      !(s.mode & 0o111) ||
      (privateCopy && (s.mode & 0o7777) !== 0o500) ||
      s.size < 1 ||
      s.size > maxSize
    )
      throw Error('Pinned executable metadata changed');
    const metadata = { ...identity(s), nlink: s.nlink, size: s.size };
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      !same(metadata, { ...identity(after), nlink: after.nlink, size: after.size }) ||
      !same(metadata, { ...identity(current), nlink: current.nlink, size: current.size }) ||
      realpathSync(path) !== path ||
      data.length !== s.size
    )
      throw Error('Pinned executable changed while reading');
    return { data, metadata };
  } finally {
    closeSync(fd);
  }
}
function sync(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function canonicalTarget(root, sha256, kind) {
  if (kind !== 'device-login' && kind !== 'routing-cli')
    throw Error('Known public program kind required');
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw Error('Pinned public executable digest required');
  return join(
    root,
    'symposium/bin',
    (kind === 'device-login' ? 'codex-device-auth-' : 'openshell-routing-') + sha256.slice(0, 12),
  );
}
function inspectPinnedProgram(root, pin, kind) {
  if (pin?.executable !== canonicalTarget(root, pin?.sha256, kind))
    throw Error('Exact canonical program pin required');
  const directories = {
    ...programDirectories(root),
    bin: privateDirectory(join(root, 'symposium/bin')),
  };
  const { data, metadata: file } = readProgram(pin.executable, true);
  if (hash(data) !== pin.sha256) throw Error('Pinned executable digest changed');
  return { directories, file };
}

/** Provision only the public program. Never repair an existing unsafe directory or file. */
export function preparePinnedProgram(root, input, sha256, kind = 'device-login') {
  const target = canonicalTarget(root, sha256, kind);
  const { data } = readProgram(input);
  if (hash(data) !== sha256) throw Error('Selected native sign-in program changed');
  const before = programDirectories(root);
  const parent = join(root, 'symposium/bin');
  if (!lstatSync(parent, { throwIfNoEntry: false })) {
    mkdirSync(parent, { mode: 0o700 });
    sync(join(root, 'symposium'));
  }
  privateDirectory(parent);
  if (!same(before, programDirectories(root)))
    throw Error('Program parent changed during provisioning');
  if (!lstatSync(target, { throwIfNoEntry: false })) {
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500,
    );
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    sync(parent);
  }
  const pin = { executable: target, sha256 };
  return { pin, metadata: inspectPinnedProgram(root, pin, kind) };
}

/** Recheck full private metadata and planned identities before retiring the original owner. */
export function assertPinnedProgram(root, pin, expected, kind = 'device-login') {
  if (!same(inspectPinnedProgram(root, pin, kind), expected))
    throw Error('Exact planned executable or directory identity changed');
}
