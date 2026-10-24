import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, delimiter, resolve, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { vi } from 'vitest';

const acceptedMgmt = '3077b7b4dcdf0ef097062794b2ab93d33c1d89ad';
const fixtureHash = 'cb0dc4b4a791163cadb5ea4953b02763f79cc399d5534b3235b1e576a6483342';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Execute the real pinned MGMT read CLI against only the synthetic canonical
 * database. No .git, user YAML, profiles, credentials or live database is copied.
 * Bundled source is exact accepted3077 Git bytes, matching the earlier executed
 * fixture. An optional explicit checkout must match those same bytes. Python
 * dependencies are test-only and pinned by the accepted MGMT lock; no user site.
 */
export async function installPrivateCanonicalReadCli(workspace: string, dbPath: string) {
  const source = process.env.S9_MGMT_SOURCE_ROOT;
  const python = process.env.S9_MGMT_PYTHON ?? 'python3';
  const temp = await realpath(tmpdir());
  for (const path of [workspace, dirname(dbPath)]) {
    const selected = await realpath(path);
    if (!relative(temp, selected) || relative(temp, selected).startsWith('..'))
      throw Error('Joined CLI may use private temporary fixture paths only');
  }
  if (process.env.TELOS_DB_PATH !== dbPath)
    throw Error('Canonical fixture DB must be explicitly selected before CLI installation');
  const manifest = JSON.parse(
    await readFile(new URL('./fixtures/mgmt-read-cli-3077.manifest.json', import.meta.url), 'utf8'),
  ) as {
    source: string;
    archiveSha256: string;
    files: Record<string, string>;
    dependencies: { yaml: string };
  };
  if (manifest.source !== acceptedMgmt || manifest.archiveSha256 !== fixtureHash)
    throw Error('Accepted canonical read fixture identity changed');
  const archive = await readFile(new URL('./fixtures/mgmt-read-cli-3077.json.gz', import.meta.url));
  if (hash(archive) !== fixtureHash) throw Error('Canonical read fixture bytes changed');
  const retained = JSON.parse(
    gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 }).toString(),
  ) as {
    source: string;
    files: Record<string, string>;
  };
  if (
    retained.source !== acceptedMgmt ||
    JSON.stringify(Object.keys(retained.files).sort()) !==
      JSON.stringify(Object.keys(manifest.files).sort())
  )
    throw Error('Canonical read source manifest changed');
  if (source) {
    const observed = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (observed !== acceptedMgmt) throw Error('MGMT source pin changed; review before intake');
  }
  const interpreter = JSON.parse(
    execFileSync(
      python,
      [
        '-I',
        '-B',
        '-c',
        'import sys,json,yaml; assert sys.version_info >= (3,11); print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"yaml":yaml.__version__}))',
      ],
      { encoding: 'utf8' },
    ),
  ) as { executable: string; version: string; yaml: string };
  if (interpreter.yaml !== manifest.dependencies.yaml)
    throw Error(
      'Select the locked test Python dependency from fixtures/mgmt-read-requirements.txt',
    );
  const pins: Record<string, string> = {};
  for (const file of Object.keys(manifest.files)) {
    if (
      !file.startsWith('command_center/') ||
      !file.endsWith('.py') ||
      file.includes('\\') ||
      file.split('/').includes('..')
    )
      throw Error('Invalid canonical fixture source path');
    const bytes = source
      ? execFileSync('git', ['-C', source, 'show', acceptedMgmt + ':' + file])
      : Buffer.from(retained.files[file], 'base64');
    if (hash(bytes) !== manifest.files[file]) throw Error('Canonical read source file changed');
    const target = resolve(workspace, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    pins[file] = hash(bytes);
  }
  const manual = join(workspace, 'command_center/data/manual_items.yaml');
  await mkdir(dirname(manual), { recursive: true });
  await writeFile(manual, '[]\n');
  vi.stubEnv('MGMT_MANUAL_ITEMS_PATH', manual);
  vi.stubEnv('PATH', dirname(interpreter.executable) + delimiter + process.env.PATH);
  vi.stubEnv('PYTHONDONTWRITEBYTECODE', '1');
  vi.stubEnv('PYTHONNOUSERSITE', '1');
  vi.stubEnv('PYTHONPATH', undefined);
  return {
    source: acceptedMgmt,
    files: pins,
    sourceSelection: source ? 'explicit-exact-git' : 'bundled-exact-git-bytes',
    python: interpreter,
    db: dbPath,
    taskWorkspaceHasRepository: false,
  };
}
