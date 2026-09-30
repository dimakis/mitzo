import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
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

it('uploads a private snapshot that survives changes to the selected publication and cleans up', () => {
  const config = fixture();
  const commit = 'a'.repeat(40);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', root);
  writeFileSync(join(root, 'baseline.json'), JSON.stringify({ startingCommit: commit }));
  writeFileSync(join(config.seed, 'note.md'), 'Accepted A');
  const prepared = prepareOpenShellSeed({
    ...config,
    seedStackManifest: {
      runtime: { image: config.image, mgmtSourceCommit: commit },
    },
  });
  expect(prepared.seed).not.toBe(config.seed);
  writeFileSync(join(config.seed, 'note.md'), 'Later B');
  expect(readFileSync(join(prepared.seed, 'note.md'), 'utf8')).toBe('Accepted A');
  const snapshot = prepared.seed;
  prepared.cleanup();
  expect(existsSync(snapshot)).toBe(false);
});
