import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openShellRuntimeConfig,
  prepareOpenShellSeed,
  verifiedOpenShellSeed,
} from '../openshell-runtime.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  vi.unstubAllEnvs();
});
function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-knowledge-admission-')));
  const seed = join(root, 'mgmt');
  mkdirSync(seed);
  return { seed, image: 'runtime:fixture' };
}

it('rejects a dynamic publication without a trusted runtime manifest at runtime admission', () => {
  const config = fixture();
  writeFileSync(
    join(root, 'baseline.json'),
    JSON.stringify({
      startingCommit: 'b'.repeat(40),
      runtimeBaseCommit: 'a'.repeat(40),
    }),
  );
  expect(() => verifiedOpenShellSeed(config)).toThrow(/complete stack lock/);
});

it('binds runtime admission to the selected image and exact baseline', () => {
  const config = fixture();
  const commit = 'a'.repeat(40);
  writeFileSync(join(root, 'baseline.json'), JSON.stringify({ startingCommit: commit }));
  const seedStackManifest = { runtime: { image: config.image, mgmtSourceCommit: commit } };
  expect(verifiedOpenShellSeed({ ...config, seedStackManifest })).toBe(config.seed);
  expect(() =>
    verifiedOpenShellSeed({ ...config, image: 'runtime:other', seedStackManifest }),
  ).toThrow(/image.*stack lock/);
  expect(() =>
    verifiedOpenShellSeed({
      ...config,
      seedStackManifest: {
        runtime: { image: config.image, mgmtSourceCommit: 'b'.repeat(40) },
      },
    }),
  ).toThrow(/commit.*stack lock/);
});

it('loads an explicitly selected absolute stack manifest for the runtime consumer', () => {
  const config = fixture();
  const manifestPath = join(root, 'stack.json');
  const manifest = { runtime: { image: config.image, mgmtSourceCommit: 'a'.repeat(40) } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const env = {
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_IMAGE: config.image,
    MITZO_OPENSHELL_POLICY: '/policy',
    MITZO_OPENSHELL_SEED: config.seed,
    MITZO_OPENSHELL_STACK_MANIFEST: manifestPath,
  };
  expect(openShellRuntimeConfig(env)).toMatchObject({ seedStackManifest: manifest });
  expect(() =>
    openShellRuntimeConfig({ ...env, MITZO_OPENSHELL_STACK_MANIFEST: 'relative' }),
  ).toThrow(/stack manifest.*absolute/);
});

it.each(['exact', 'absent', 'stale'] as const)(
  'uploads an immutable private snapshot with static file manifest metadata=%s',
  (withFiles) => {
    const config = fixture();
    const commit = 'a'.repeat(40);
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
    const content = 'Accepted A';
    const note = 'AGENTS.md';
    const baseline = JSON.stringify({
      startingCommit: commit,
      ...(withFiles !== 'absent'
        ? {
            files: {
              [note]: {
                sha256: createHash('sha256').update(content).digest('hex'),
                mode: withFiles === 'stale' ? '0600' : '0644',
              },
            },
          }
        : {}),
    });
    writeFileSync(join(root, 'baseline.json'), baseline);
    writeFileSync(join(config.seed, note), content);
    chmodSync(join(config.seed, note), 0o644);
    const previous = process.umask(0o077);
    let prepared: ReturnType<typeof prepareOpenShellSeed>;
    try {
      prepared = prepareOpenShellSeed({
        ...config,
        seedStackManifest: {
          runtime: { image: config.image, mgmtSourceCommit: commit },
        },
      });
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(prepared.seed, '..')).mode & 0o777).toBe(0o700);
    expect(prepared.seed).not.toBe(config.seed);
    expect(readFileSync(join(config.seed, note), 'utf8')).toBe(content);
    expect(statSync(join(config.seed, note)).mode & 0o777).toBe(0o644);
    writeFileSync(join(config.seed, note), 'Later B');
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ startingCommit: 'b'.repeat(40) }));
    expect(readFileSync(join(prepared.seed, note), 'utf8')).toBe('Accepted A');
    expect(readFileSync(join(prepared.seed, '..', 'baseline.json'), 'utf8')).toBe(baseline);
    expect(statSync(join(prepared.seed, note)).mode & 0o777).toBe(0o644);
    const snapshot = prepared.seed;
    prepared.cleanup();
    expect(existsSync(snapshot)).toBe(false);
  },
);
