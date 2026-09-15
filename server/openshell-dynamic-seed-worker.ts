import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';

interface BaselineFile {
  sha256: string;
  mode: string;
}

interface Baseline {
  startingCommit: string;
  runtimeBaseCommit: string;
  runtimeDependencyProjectionSha256: string;
  payloadSha256: string;
  files: Record<string, BaselineFile>;
}

interface Stack {
  image: string;
  mgmtSourceCommit: string;
  dependencyProjectionSha256: string;
  seedPayloadSha256: string;
}

interface Input {
  source: string;
  parent: string;
  baseline: Baseline;
  stack: Stack;
  image: string;
}

interface Identity {
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  gid: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

const input = workerData as Input;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function compareUtf8(left: string, right: string) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function canonicalSeedJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      const object = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort(compareUtf8)
          .map((key) => [key, normalize(object[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function sameIdentity(
  before: NonNullable<ReturnType<typeof lstatSync>>,
  after: NonNullable<ReturnType<typeof lstatSync>>,
) {
  return before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('OpenShell dynamic seed private snapshot is not a directory');
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function validateContract(baseline: Baseline, stack: Stack, image: string) {
  if (
    !COMMIT.test(baseline.startingCommit) ||
    !COMMIT.test(baseline.runtimeBaseCommit) ||
    !SHA256.test(baseline.runtimeDependencyProjectionSha256) ||
    !SHA256.test(baseline.payloadSha256) ||
    !baseline.files ||
    typeof baseline.files !== 'object'
  )
    throw new Error('OpenShell dynamic seed baseline is malformed');
  for (const [path, file] of Object.entries(baseline.files)) {
    if (
      !path ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      !SHA256.test(file.sha256) ||
      !/^[0-7]{4}$/.test(file.mode)
    )
      throw new Error('OpenShell dynamic seed baseline file manifest is malformed');
  }
  if (!/^[^@\s]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('OpenShell dynamic seed requires a digest-pinned configured image');
  if (stack.image !== image)
    throw new Error('OpenShell dynamic seed stack lock image does not match the configured image');
  if (baseline.runtimeBaseCommit !== stack.mgmtSourceCommit)
    throw new Error('OpenShell dynamic seed runtime base does not match the stack lock');
  if (baseline.runtimeDependencyProjectionSha256 !== stack.dependencyProjectionSha256)
    throw new Error('OpenShell dynamic seed dependency projection does not match the stack lock');
  const digest = createHash('sha256')
    .update(
      canonicalSeedJson({
        startingCommit: baseline.startingCommit,
        runtimeBaseCommit: baseline.runtimeBaseCommit,
        runtimeDependencyProjectionSha256: baseline.runtimeDependencyProjectionSha256,
        files: baseline.files,
      }),
      'utf8',
    )
    .digest('hex');
  if (digest !== baseline.payloadSha256)
    throw new Error('OpenShell dynamic seed payload digest does not match baseline');
  if (digest !== stack.seedPayloadSha256)
    throw new Error('OpenShell dynamic seed payload digest does not match the stack lock');
}

function copyWithoutSymlinks(source: string, destination: string) {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const before = lstatSync(from);
    if (before.isSymbolicLink())
      throw new Error(`OpenShell dynamic seed contains an unsafe symlink: ${entry.name}`);
    if (before.isDirectory()) {
      copyWithoutSymlinks(from, to);
    } else if (before.isFile()) {
      const contents = readFileSync(from);
      const after = lstatSync(from);
      if (after.isSymbolicLink() || !sameIdentity(before, after))
        throw new Error(`OpenShell dynamic seed changed while it was being copied: ${entry.name}`);
      writeFileSync(to, contents, { mode: before.mode & 0o7777 });
      chmodSync(to, before.mode & 0o7777);
    } else {
      throw new Error(`OpenShell dynamic seed contains an unsupported path: ${entry.name}`);
    }
  }
}

function validateSnapshot(seed: string, baseline: Baseline) {
  const expected = new Map(Object.entries(baseline.files));
  const actual = new Map<string, BaselineFile>();
  const manifests = new Map<string, Buffer>();
  const manifestPaths = new Set(
    ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json'].map(
      (name) => `memory/manifest/${name}`,
    ),
  );
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`OpenShell dynamic seed contains an unsafe symlink: ${path}`);
      if (stat.isDirectory()) walk(absolute, path);
      else if (stat.isFile()) {
        const contents = readFileSync(absolute);
        actual.set(path, {
          sha256: createHash('sha256').update(contents).digest('hex'),
          mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
        });
        if (manifestPaths.has(path)) manifests.set(path, contents);
      } else throw new Error(`OpenShell dynamic seed contains an unsupported path: ${path}`);
    }
  };
  walk(seed);
  if (
    actual.size !== expected.size ||
    [...actual.keys()].some((path) => !expected.has(path)) ||
    [...expected.keys()].some((path) => !actual.has(path))
  )
    throw new Error('OpenShell dynamic seed files do not exactly match its baseline');
  for (const [path, expectedFile] of expected) {
    const actualFile = actual.get(path)!;
    if (actualFile.sha256 !== expectedFile.sha256 || actualFile.mode !== expectedFile.mode)
      throw new Error(`OpenShell dynamic seed file hash or mode does not match baseline: ${path}`);
  }
  for (const name of ['index.json', 'wikilinks.json', 'by_type.json', 'by_tag.json']) {
    const path = `memory/manifest/${name}`;
    const contents = manifests.get(path);
    let manifest: unknown;
    try {
      manifest = contents && JSON.parse(contents.toString('utf8'));
    } catch {
      manifest = undefined;
    }
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      (manifest as { sourceCommit?: unknown }).sourceCommit !== baseline.startingCommit
    )
      throw new Error(
        `OpenShell dynamic seed manifest provenance does not match baseline: ${name}`,
      );
  }
}

function run() {
  validateContract(input.baseline, input.stack, input.image);
  const token = randomUUID();
  const snapshotRoot = join(input.parent, `snapshot-${token}`);
  const snapshot = join(snapshotRoot, 'mgmt');
  try {
    mkdirSync(snapshotRoot, { mode: 0o700 });
    chmodSync(snapshotRoot, 0o700);
    copyWithoutSymlinks(input.source, snapshot);
    // One complete tree walk hashes the canonical payload and validates every
    // file plus all four manifest provenance records before returning it.
    validateSnapshot(snapshot, input.baseline);
    parentPort?.postMessage({ ok: true, path: snapshot, token, identity: identity(snapshot) });
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

try {
  run();
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : 'OpenShell dynamic seed worker failed',
  });
}
