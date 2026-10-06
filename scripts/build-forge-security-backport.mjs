import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/security');
const upstream = join(vendor, 'node-forge-1.4.0.tgz');
const integrity =
  'sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==';
if ('sha512-' + createHash('sha512').update(readFileSync(upstream)).digest('base64') !== integrity)
  throw new Error('Upstream forge archive does not match pinned npm integrity');
const build = mkdtempSync(join(tmpdir(), 'mitzo-forge-backport-'));
try {
  execFileSync('tar', ['-xzf', upstream, '-C', build]);
  const packageRoot = join(build, 'package');
  execFileSync('patch', ['-p1', '--fuzz=0', '-i', join(vendor, 'node-forge-rsa.patch')], {
    cwd: packageRoot,
  });
  const packagePath = join(packageRoot, 'package.json');
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  metadata.name = '@mitzo/node-forge-security';
  metadata.version = '1.4.0-mitzo.2';
  metadata.mitzoSecurityBackport = {
    upstream: 'node-forge@1.4.0',
    integrity,
    advisory: 'GHSA-86w9-cpqp-85rv',
    proposal: 'https://github.com/digitalbazaar/forge/pull/1152',
  };
  // Node consumers use lib/index.js; do not ship unpatched prebuilt browser bundles.
  metadata.files = ['lib', 'LICENSE', 'README.md'];
  delete metadata.browser;
  delete metadata.scripts;
  delete metadata.devDependencies;
  writeFileSync(packagePath, JSON.stringify(metadata, null, 2) + '\n');
  const packed = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--cache',
        join(build, 'npm-cache'),
        '--offline',
        '--json',
        '--pack-destination',
        build,
      ],
      { cwd: packageRoot, encoding: 'utf8' },
    ),
  )[0];
  const output = join(vendor, packed.filename);
  const result = readFileSync(join(build, packed.filename));
  if (process.argv.includes('--verify')) {
    if (!result.equals(readFileSync(output)))
      throw new Error('Forge backport archive is not reproducible from pinned input and patch');
  } else copyFileSync(join(build, packed.filename), output);
  console.log(
    'Verified forge security backport: ' + createHash('sha256').update(result).digest('hex'),
  );
} finally {
  rmSync(build, { recursive: true, force: true });
}
