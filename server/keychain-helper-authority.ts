import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export interface PreparedKeychainHelper {
  readonly file: string;
  dispose(): void;
}

/** Root-owned system aliases are permitted, but user-controlled symlinks and
 * ancestry writable by other users are not. Same-user unsandboxed applications
 * belong to the controller trust boundary; provider sandboxes deny this tree. */
function trustedDirectory(path: string): string {
  path = resolve(path);
  const root = parse(path).root;
  let current = root;
  for (const component of ['', ...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    let info = lstatSync(current);
    if (info.isSymbolicLink()) {
      const parent = lstatSync(dirname(current));
      if (info.uid !== 0 || parent.uid !== 0 || (parent.mode & 0o022) !== 0)
        throw new Error('Untrusted helper ancestry');
      current = trustedDirectory(realpathSync(current));
      info = lstatSync(current);
    }
    if (
      !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
    )
      throw new Error('Untrusted helper ancestry');
  }
  return current;
}

/** execFile accepts a pathname, not a bound executable descriptor. Never use
 * /dev/fd as an executable fallback on macOS. Copy from an opened regular file
 * into the SDK-denied controller tree, then codesign and execute that copy. */
export function prepareKeychainHelper(
  source: string,
  storage = join(homedir(), '.mitzo', 'keychain-helper', 'executables'),
): PreparedKeychainHelper {
  if (!isAbsolute(source)) throw new Error('Helper path must be absolute');
  source = join(trustedDirectory(dirname(source)), parse(source).base);
  const original = lstatSync(source);
  if (
    !original.isFile() ||
    original.nlink !== 1 ||
    (original.uid !== 0 && original.uid !== process.getuid?.()) ||
    (original.mode & 0o022) !== 0 ||
    (original.mode & 0o111) === 0
  )
    throw new Error('Untrusted helper file');

  // Validate existing ancestors before recursive creation, then validate again.
  let existing = resolve(storage);
  while (
    !(() => {
      try {
        lstatSync(existing);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return false;
      }
    })()
  )
    existing = dirname(existing);
  trustedDirectory(existing);
  mkdirSync(storage, { recursive: true, mode: 0o700 });
  storage = trustedDirectory(storage);
  const info = lstatSync(storage);
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error('Helper storage must be private');
  const directory = mkdtempSync(join(storage, 'verified-'));
  const file = join(directory, 'helper');
  try {
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== original.dev ||
        opened.ino !== original.ino ||
        opened.size < 1 ||
        opened.size > 32 * 1024 * 1024
      )
        throw new Error('Helper changed while opening');
      writeFileSync(file, readFileSync(fd), { flag: 'wx', mode: 0o500 });
    } finally {
      closeSync(fd);
    }
    return { file, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
