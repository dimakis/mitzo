import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPackageArchive } from './security-backport-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/security');
const upstream = join(vendor, 'zod-3.25.76.tgz');
const integrity =
  'sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==';
if ('sha512-' + createHash('sha512').update(readFileSync(upstream)).digest('base64') !== integrity)
  throw new Error('Upstream Zod archive does not match pinned npm integrity');
const build = mkdtempSync(join(tmpdir(), 'mitzo-zod3-backport-'));
try {
  execFileSync('tar', ['-xzf', upstream, '-C', build]);
  const packageRoot = join(build, 'package');
  execFileSync('patch', ['-p1', '--fuzz=0', '-i', join(vendor, 'zod3-collection-bounds.patch')], {
    cwd: packageRoot,
  });
  const packagePath = join(packageRoot, 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  metadata.name = '@mitzo/zod3-sandbox-security';
  metadata.version = '3.25.76-mitzo.1';
  metadata.mitzoSecurityBackport = {
    upstream: 'zod@3.25.76',
    integrity,
    advisory: 'GHSA-mrhx-c7xc-m3w5',
    upstreamFix:
      'https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd',
    scope:
      'Reject oversized array max/length and set max before element parsing; unbounded schemas are unchanged.',
  };
  metadata.exports = Object.fromEntries(
    ['./package.json', '.', './v3'].map((key) => [key, metadata.exports[key]]),
  );
  metadata.files = ['index.*', 'v3', 'src/index.ts', 'src/v3', 'LICENSE', 'README.md'];
  delete metadata.scripts;
  delete metadata.zshy;
  const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  const names = ['LICENSE', 'README.md', 'package.json', 'src/index.ts'];
  const collect = (directory) => {
    for (const entry of readdirSync(join(packageRoot, directory), { withFileTypes: true })) {
      const name = directory + '/' + entry.name;
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts)$/.test(entry.name)) names.push(name);
      else throw new Error('Unexpected Zod backport archive entry');
    }
  };
  collect('v3');
  collect('src/v3');
  names.push(
    ...readdirSync(packageRoot).filter((name) => /^index\.(?:[cm]?js|d\.[cm]?ts)$/.test(name)),
  );
  const files = names.map((name) => ({
    name: 'package/' + name,
    data: name === 'package.json' ? metadataBytes : readFileSync(join(packageRoot, name)),
  }));
  const output = join(vendor, 'mitzo-zod3-sandbox-security-3.25.76-mitzo.1.tgz');
  const result = canonicalPackageArchive(files);
  if (process.argv.includes('--verify')) {
    if (!result.equals(readFileSync(output)))
      throw new Error('Zod3 backport archive is not reproducible from pinned input and patch');
  } else writeFileSync(output, result);
  console.log(
    'Verified Zod3 security backport: ' + createHash('sha256').update(result).digest('hex'),
  );
} finally {
  rmSync(build, { recursive: true, force: true });
}
