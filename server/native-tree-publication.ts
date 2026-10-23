import { dirname, isAbsolute, resolve } from 'node:path';
import type { NativeReadAnchor, NativeReadIdentity } from './native-file-operation.js';

export interface NativeExclusiveTreeEntry {
  readonly path: string;
  readonly mode: '040000' | '100644' | '100755' | '120000';
  readonly identity: NativeReadIdentity;
  readonly size: number;
  readonly sha256: string;
}
export interface NativeExclusiveTreeRequest {
  readonly file_path: string;
  readonly rootAnchor: NativeReadAnchor;
  readonly parentIdentity: NativeReadIdentity;
  readonly targetIdentity: NativeReadIdentity;
  readonly payload: {
    readonly file_path: string;
    readonly rootAnchor: NativeReadAnchor;
    readonly parentIdentity: NativeReadIdentity;
    readonly identity: NativeReadIdentity;
  };
  readonly originalSourcePath: string;
  readonly deniedRoots: readonly string[];
  readonly entries: readonly NativeExclusiveTreeEntry[];
}
const unavailable = () => Error('Exclusive tree unavailable');
function data(value: unknown, key: string): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw unavailable();
  return descriptor.value;
}
function path(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value === '/' ||
    resolve(value) !== value ||
    Buffer.byteLength(value) > 4096 ||
    value.split('/').length > 128 ||
    /[\0\r\n]/.test(value)
  )
    throw unavailable();
  return value;
}
function identity(value: unknown): NativeReadIdentity {
  const dev = data(value, 'dev'),
    ino = data(value, 'ino');
  if (
    Reflect.ownKeys(value as object).length !== 2 ||
    typeof dev !== 'string' ||
    typeof ino !== 'string' ||
    !/^\d{1,32}$/.test(dev) ||
    !/^\d{1,32}$/.test(ino)
  )
    throw unavailable();
  return Object.freeze({ dev, ino });
}
function anchor(value: unknown): NativeReadAnchor {
  return Object.freeze({
    rootPath: path(data(value, 'rootPath')),
    identity: identity(data(value, 'identity')),
  });
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  )
    throw unavailable();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw unavailable();
    return descriptor.value;
  });
}
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
/** Restrictive filename policy only; this never canonicalizes a permission path.
 * Credential/agent and Git metadata aliases are refused, including conservative
 * case/Unicode variants. Excluded tracked entries fail the WHOLE publication. */
export function validNativeTreeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 4096 ||
    !value ||
    value.startsWith('/') ||
    /[\0\r\n\\]/.test(value)
  )
    return false;
  const parts = value.split('/');
  return (
    parts.length <= 128 &&
    parts.every((part) => {
      const restricted = part.normalize('NFKC').toLowerCase();
      return (
        !!part &&
        !['.', '..'].includes(part) &&
        !Array.from(part).some(
          (char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127,
        ) &&
        !/\p{Cf}/u.test(part) &&
        !/[ .]$/.test(part) &&
        ![
          '.git',
          '.ssh',
          '.aws',
          '.gnupg',
          '.kube',
          '.azure',
          '.gcloud',
          'keychains',
          '.claude',
          '.cursor',
          '.codex',
        ].includes(restricted) &&
        !/^\.?git~\d+$/i.test(restricted)
      );
    })
  );
}
/** NEGATIVE-only comparison. It never proves physical equality or absence,
 * selects a root or grants access. ASCII case variants and Unicode-normalized
 * matches are conservatively refused; a divergent non-ASCII component is also
 * unknown/refused rather than treating Unicode folding as a permission oracle. */
function mayOverlapForRefusal(a: string, b: string): boolean {
  const left = a.split('/').filter(Boolean),
    right = b.split('/').filter(Boolean);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]
      .normalize('NFD')
      .replace(/\p{Cf}/gu, '')
      .toLowerCase();
    const y = right[i]
      .normalize('NFD')
      .replace(/\p{Cf}/gu, '')
      .toLowerCase();
    if (x !== y) return Array.from(left[i] + right[i]).some((char) => char.codePointAt(0)! > 127);
  }
  return true;
}
/** Bounded immutable server data, never a grant. Reject all nested denials of
 * projected original/task/staging trees rather than infer filesystem-equivalent
 * path absence from spelling. Actual transport retains complete OS denials. */
export function projectExclusiveTreeRequest(input: unknown): Readonly<NativeExclusiveTreeRequest> {
  const target = path(data(input, 'file_path')),
    root = anchor(data(input, 'rootAnchor'));
  const sourceValue = data(input, 'payload'),
    source = path(data(sourceValue, 'file_path')),
    sourceRoot = anchor(data(sourceValue, 'rootAnchor'));
  const originalSourcePath = path(data(input, 'originalSourcePath'));
  if (
    target === root.rootPath ||
    dirname(target) !== root.rootPath ||
    source === sourceRoot.rootPath ||
    !within(source, sourceRoot.rootPath) ||
    within(source, target) ||
    within(target, sourceRoot.rootPath)
  )
    throw unavailable();
  const deniedRoots = Object.freeze(
    array(data(input, 'deniedRoots'), 256).map((value) => {
      if (value === '/') return '/';
      return path(value);
    }),
  );
  if (
    Buffer.byteLength(JSON.stringify(deniedRoots)) > 65536 ||
    [target, source, originalSourcePath].some((tree) =>
      deniedRoots.some((denied) => mayOverlapForRefusal(tree, denied)),
    )
  )
    throw unavailable();
  let bytes = 0;
  const entries = array(data(input, 'entries'), 10000).map((value) => {
    const relative = data(value, 'path'),
      mode = data(value, 'mode'),
      size = data(value, 'size'),
      sha256 = data(value, 'sha256');
    if (
      !validNativeTreeRelativePath(relative) ||
      typeof mode !== 'string' ||
      !['040000', '100644', '100755', '120000'].includes(mode) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 16 * 1024 * 1024 ||
      (mode === '040000' && size !== 0) ||
      (mode === '120000' && size > 4096) ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      (bytes += size) > 128 * 1024 * 1024
    )
      throw unavailable();
    return Object.freeze({
      path: relative,
      mode: mode as NativeExclusiveTreeEntry['mode'],
      identity: identity(data(value, 'identity')),
      size,
      sha256,
    });
  });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (
    byPath.size !== entries.length ||
    new Set(entries.map((entry) => entry.path.normalize('NFD').toLowerCase())).size !==
      entries.length ||
    entries.some((entry) => {
      const parts = entry.path.split('/');
      parts.pop();
      return parts.length > 0 && byPath.get(parts.join('/'))?.mode !== '040000';
    })
  )
    throw unavailable();
  const projected = Object.freeze({
    file_path: target,
    rootAnchor: root,
    parentIdentity: identity(data(input, 'parentIdentity')),
    targetIdentity: identity(data(input, 'targetIdentity')),
    payload: Object.freeze({
      file_path: source,
      rootAnchor: sourceRoot,
      parentIdentity: identity(data(sourceValue, 'parentIdentity')),
      identity: identity(data(sourceValue, 'identity')),
    }),
    originalSourcePath,
    deniedRoots,
    entries: Object.freeze(entries),
  });
  if (
    projected.parentIdentity.dev !== root.identity.dev ||
    projected.parentIdentity.ino !== root.identity.ino
  )
    throw unavailable();
  // Includes full encoded paths/manifest. Refuse before launch; do not silently
  // truncate a large manifest or turn its omitted paths into absent entries.
  if (Buffer.byteLength(JSON.stringify(projected)) > 120 * 1024) throw unavailable();
  return projected;
}
