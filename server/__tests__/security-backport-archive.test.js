import { afterEach, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPackageArchive } from '../../scripts/security-backport-archive.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('produces identical bytes independent of file order and yields interoperable tar/gzip', () => {
  const files = [
    { name: 'package/package.json', data: Buffer.from('{"name":"fixture"}') },
    { name: 'package/lib/index.js', data: Buffer.from('x'.repeat(150000)) },
    { name: 'package/LICENSE', data: Buffer.from('license') },
  ];
  const archive = canonicalPackageArchive(files);
  expect(canonicalPackageArchive([...files].reverse())).toEqual(archive);
  expect(archive.subarray(0, 10).toString('hex')).toBe('1f8b08000000000000ff');
  expect(gunzipSync(archive).subarray(100, 108).toString()).toBe('0000644\0');
  const root = mkdtempSync(join(tmpdir(), 'mitzo-canonical-tar-'));
  roots.push(root);
  writeFileSync(join(root, 'artifact.tgz'), archive);
  execFileSync('tar', ['-xzf', join(root, 'artifact.tgz'), '-C', root]);
  expect(readFileSync(join(root, 'package/lib/index.js'), 'utf8')).toBe('x'.repeat(150000));
  const damaged = Buffer.from(archive);
  damaged[damaged.length - 8] ^= 1;
  expect(() => gunzipSync(damaged)).toThrow();
});
it('rejects traversal, duplicate names and truncated header names', () => {
  for (const name of [
    '../outside',
    'package/../outside',
    '/absolute',
    'package/' + 'x'.repeat(100),
  ])
    expect(() => canonicalPackageArchive([{ name, data: Buffer.from('x') }])).toThrow();
  expect(() =>
    canonicalPackageArchive([
      { name: 'package/LICENSE', data: Buffer.from('a') },
      { name: 'package/LICENSE', data: Buffer.from('b') },
    ]),
  ).toThrow();
});
