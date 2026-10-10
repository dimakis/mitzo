import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/** node-pty 1.1.0 ships its macOS spawn helper without the executable archive bit. */
export function prepareTerminalNative(root, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') return;
  const prebuilt = join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
  const helper = existsSync(prebuilt) ? prebuilt : join(root, 'build', 'Release', 'spawn-helper');
  const status = statSync(helper);
  if (!status.isFile()) throw Error('Terminal native helper is not a file');
  chmodSync(helper, status.mode | 0o111);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url),
    root = dirname(require.resolve('node-pty/package.json'));
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (metadata.version !== '1.1.0')
    throw Error('Review native helper installation for this node-pty version');
  prepareTerminalNative(root);
}
