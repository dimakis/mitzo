import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from './bounded-file-read.js';
const unavailable = () => Error('Host Codex login unavailable');
const Auth = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    id_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});
export type Identity = { dev: number; ino: number };
export type AuthIdentity = Identity & { sha256: string };
export type FileStamp = Identity & { size: number; mtimeMs: number; ctimeMs: number };
export function fileStamp(info: Stats): FileStamp {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}
export function sameFileStamp(info: Stats, expected: FileStamp): boolean {
  return (
    info.dev === expected.dev &&
    info.ino === expected.ino &&
    info.size === expected.size &&
    info.mtimeMs === expected.mtimeMs &&
    info.ctimeMs === expected.ctimeMs
  );
}
export function directory(path: string): Identity {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw unavailable();
  return { dev: stat.dev, ino: stat.ino };
}
export function sameIdentity(actual: Identity, expected: Identity): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw unavailable();
}
export function readAuth(root: string): {
  bytes: Buffer;
  identity: AuthIdentity;
  stamp: FileStamp;
} {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(root, 'auth.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.uid !== process.getuid?.()
    )
      throw unavailable();
    const bytes = readBoundedFile(fd, Math.min(before.size, 1024 * 1024));
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw unavailable();
    Auth.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const leaf = lstatSync(join(root, 'auth.json'));
    sameIdentity(leaf, before);
    if (!leaf.isFile()) throw unavailable();
    return {
      bytes,
      stamp: fileStamp(before),
      identity: {
        dev: before.dev,
        ino: before.ino,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
