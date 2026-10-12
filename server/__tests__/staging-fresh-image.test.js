import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
const home = vi.hoisted(() => `/private/tmp/mitzo-image-proof-${globalThis.process.pid}`);
vi.mock('node:os', () => ({ homedir: () => home }));
import { createFreshStagingImageInspector } from '../../scripts/lib/staging-fresh-image.mjs';
const root = join(home, '.local/share/mitzo-staging');
afterEach(() => rmSync(home, { recursive: true, force: true }));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(raw = Buffer.alloc(4096, 1), expandedBytes = raw.length) {
  const compressed = zstdCompressSync(raw),
    sha256 = hash(compressed);
  const dir = join(root, 'symposium/image-sources');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, sha256 + '-arm64.raw.zst');
  writeFileSync(path, compressed, { mode: 0o600 });
  const s = lstatSync(path);
  const image = {
    path,
    dev: s.dev,
    ino: s.ino,
    uid: s.uid,
    mode: 0o600,
    nlink: 1,
    size: s.size,
    sha256,
    expandedBytes,
    compression: 'zstd',
  };
  const current = vi.fn(() => true);
  const inspector = createFreshStagingImageInspector({
    canonicalRoot: root,
    image,
    nodePin: { path: process.execPath, sha256: hash(readFileSync(process.execPath)) },
    assertOriginalGuard: current,
    assertNativeAuthenticationCurrent: current,
  });
  return { image, inspector, current, path };
}
it('counts actual expanded bytes through bounded stock zstd without writing an expanded disk or minting authority', async () => {
  const f = fixture();
  expect(await f.inspector.assertApprovedImage(f.image)).toMatchObject({
    expandedBytes: 4096,
    compressedSha256: f.image.sha256,
    nativeAuthority: false,
  });
  expect(JSON.parse(JSON.stringify(f.inspector))).toEqual({});
  await f.inspector.assertApprovedImage(f.image);
  f.inspector.close();
  await expect(f.inspector.assertApprovedImage(f.image)).rejects.toThrow();
});
it('refuses a fabricated expansion count, changed input bytes, or lost original authority', async () => {
  const fabricated = fixture(Buffer.alloc(4096, 1), 1);
  await expect(fabricated.inspector.assertApprovedImage(fabricated.image)).rejects.toThrow(
    'expanded size',
  );
  fabricated.inspector.close();
  const f = fixture();
  await expect(f.inspector.assertApprovedImage({ ...f.image, expandedBytes: 1 })).rejects.toThrow();
  await f.inspector.assertApprovedImage(f.image);
  writeFileSync(f.path, 'changed private compressed image');
  await expect(f.inspector.assertApprovedImage(f.image)).rejects.toThrow();
  f.inspector.close();
  const g = fixture();
  g.current.mockReturnValue(false);
  await expect(g.inspector.assertApprovedImage(g.image)).rejects.toThrow();
  g.inspector.close();
});
it('refuses nonraw disk formats and an unsupported decoder without copying an image', async () => {
  const raw = Buffer.alloc(4096);
  raw.write('QFI\xfb', 0, 'latin1');
  const f = fixture(raw);
  await expect(f.inspector.assertApprovedImage(f.image)).rejects.toThrow('raw');
  f.inspector.close();
  expect(() =>
    createFreshStagingImageInspector({
      canonicalRoot: root,
      image: { ...f.image, compression: 'xz' },
      nodePin: {},
      assertOriginalGuard: () => true,
      assertNativeAuthenticationCurrent: () => true,
    }),
  ).toThrow();
});
