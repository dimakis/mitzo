import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join, relative, dirname } from 'node:path';
export function fingerprintDirectory(root, directory) {
  root = realpathSync(root);
  const hash = createHash('sha256');
  function walk(path) {
    const name = relative(root, path),
      stat = lstatSync(path);
    hash.update(JSON.stringify([name, stat.mode & 0o777]) + '\n');
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path),
        rel = relative(root, target);
      if (rel.startsWith('..') || rel.startsWith('/'))
        throw Error('Dependency link escaped release');
      hash.update('link:' + readlinkSync(path) + '\n');
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) walk(join(path, child));
    } else if (stat.isFile())
      hash.update(createHash('sha256').update(readFileSync(path)).digest('hex') + '\n');
    else throw Error('Unsupported release file');
  }
  walk(join(root, directory));
  return hash.digest('hex');
}
export function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 262144
    )
      throw Error('Private staging record refused');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
export function replacePrivateJson(path, value) {
  privateJson(path);
  const temp = path + '.' + randomUUID(),
    fd = openSync(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function artifacts(root) {
  const result = {};
  for (const directory of [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
  ]) {
    function walk(path) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('Compiled artifact symlink refused');
      if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
      else if (stat.isFile())
        result[relative(root, path)] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      else throw Error('Unsupported compiled artifact');
    }
    walk(join(root, directory));
  }
  return result;
}

export function stageDirectory(root, directory, create = false) {
  root = realpathSync(root);
  let path = root;
  for (const component of directory.split('/')) {
    if (!component || component === '.' || component === '..')
      throw Error('Unsafe staging directory');
    path = join(path, component);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      mkdirSync(path, { mode: 0o700 });
      stat = lstatSync(path);
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      realpathSync(path) !== path
    )
      throw Error('Aliased staging directory refused');
  }
  return path;
}
export function appendAudit(path, event) {
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw Error('Private audit file refused');
    writeFileSync(fd, JSON.stringify(event) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
