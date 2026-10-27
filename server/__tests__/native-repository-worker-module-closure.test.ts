import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nativeRepositoryFixtureWorkerSources } from './fixtures/native-repository-worker-sources.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('loads the exact compiled native worker closure before requiring a macOS sandbox target', async () => {
  const outdir = await realpath(await mkdtemp(join(tmpdir(), 'native-worker-closure-')));
  roots.push(outdir);
  const compiled = await build({
    entryPoints: nativeRepositoryFixtureWorkerSources.map((file) =>
      fileURLToPath(new URL('../' + file, import.meta.url)),
    ),
    outdir,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    bundle: false,
    metafile: true,
    logLevel: 'silent',
  });
  expect(
    Object.keys(compiled.metafile!.inputs)
      .map((path) => path.split('/').at(-1))
      .sort(),
  ).toEqual([...nativeRepositoryFixtureWorkerSources].sort());
  await writeFile(join(outdir, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(await realpath('node_modules'), join(outdir, 'node_modules'));
  const target = pathToFileURL(join(outdir, 'sandboxed-command-worker.js')).href;
  // Import only: no sandbox launch, provider process, network or model call.
  await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(target)})`],
    {
      env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test', HOME: '/nonexistent' },
      timeout: 10000,
      maxBuffer: 16384,
    },
  );
}, 15000);
