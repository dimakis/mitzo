import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import * as codex from '../../server/ordinary-local-codex-host-runtime.js';
import * as responses from '../../server/ordinary-local-responses-capabilities.js';
import * as vertex from '../../server/ordinary-local-vertex-capabilities.js';
import { OrdinaryLocalCodexTarget } from '../../server/ordinary-local-codex-capabilities.js';
import {
  checkRuntimeDeclarations,
  prepareRuntimeDeclarations,
  readPrivateEnvironment,
} from '../lib/release-runtime-declarations.mjs';
const runtime = { codex, responses, vertex };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-runtime-')));
  roots.push(root);
  const previous = join(root, 'previous');
  const next = join(root, 'candidate');
  mkdirSync(previous, { mode: 0o700 });
  mkdirSync(next, { mode: 0o700 });
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const native = {
    version: 2,
    executablePath: join(previous, 'codex'),
    executableSha256: digest,
    codeModeHostSha256: digest,
  };
  writeFileSync(native.executablePath, bytes, { mode: 0o755 });
  writeFileSync(join(previous, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  const target = {
    version: 2,
    targetId: 'host-mac-codex',
    hostId: hostname(),
    label: 'Host Mac',
    continuityContract: 'codex-native-thread-v1',
    runtimeContractRevision: 'previous-accepted-source',
  };
  const contents: Record<string, unknown> = { 'codex-native.json': native, 'codex.json': target };
  for (const kind of ['responses', 'gemini', 'vertex'])
    contents[kind + '.json'] = {
      version: 1,
      targetId: 'host-mac-' + kind,
      hostId: hostname(),
      label: 'Host Mac',
      runtimeContractRevision: 'previous-accepted-source',
    };
  let source = '# preserve operator settings\nSECRET="never-print-this-secret"\n';
  for (const kind of ['CODEX', 'RESPONSES', 'GEMINI', 'VERTEX']) {
    source += `MITZO_ORDINARY_LOCAL_${kind}_ENABLED=1\nexport MITZO_ORDINARY_LOCAL_${kind}_TARGET_FILE='${join(previous, kind.toLowerCase() + '.json')}'\n`;
  }
  source += `MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE="${join(previous, 'codex-native.json')}"\n`;
  for (const [file, value] of Object.entries(contents))
    writeFileSync(join(previous, file), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(join(next, '.env'), source, { mode: 0o600 });
  return {
    root,
    previous,
    next,
    source,
    native,
    target,
    contents,
    env: () => parse(readPrivateEnvironment(join(next, '.env'))),
  };
}
it('repairs the actual cross-release failure with compiled-runtime-equivalent validators and stable conversation identity', () => {
  const f = fixture();
  expect(() => checkRuntimeDeclarations(f.env(), runtime)).toThrow();
  const identity = new OrdinaryLocalCodexTarget(f.target).descriptor();
  const result = prepareRuntimeDeclarations(f.next, f.source, runtime);
  expect(result.changed).toBe(true);
  expect(result.targets).toHaveLength(4);
  expect(result.targets[0]).toEqual(identity);
  expect(checkRuntimeDeclarations(f.env(), runtime)).toEqual(result.targets);
  for (const [file, value] of Object.entries(f.contents))
    expect(JSON.parse(readFileSync(join(f.previous, file), 'utf8'))).toEqual(value);
  expect(f.env().SECRET).toBe('never-print-this-secret');
  for (const [name, file] of Object.entries(f.env()).filter(([name]) => name.endsWith('_FILE'))) {
    expect(file.startsWith(join(f.next, '.runtime-targets') + '/')).toBe(true);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    const next = codex.readPrivateRuntimeSettings(file) as Record<string, unknown>;
    const old = codex.readPrivateRuntimeSettings(parse(f.source)[name]) as Record<string, unknown>;
    expect({ ...next, runtimeContractRevision: old.runtimeContractRevision }).toEqual({
      ...old,
      runtimeContractRevision: old.runtimeContractRevision,
    });
  }
  const backup = readdirSync(f.next).find((file) => file.startsWith('.env.before-runtime-'))!;
  expect(readFileSync(join(f.next, backup), 'utf8')).toBe(f.source);
  const unchanged = readPrivateEnvironment(join(f.next, '.env'));
  expect(prepareRuntimeDeclarations(f.next, unchanged, runtime).changed).toBe(false);
  expect(readPrivateEnvironment(join(f.next, '.env'))).toBe(unchanged);
});
it.each(['native', 'companion', 'host', 'missing', 'legacy'])(
  'refuses %s without changing the selected environment or previous release',
  (kind) => {
    const f = fixture();
    if (kind === 'native')
      writeFileSync(f.native.executablePath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9]));
    if (kind === 'companion') rmSync(join(f.previous, 'codex-code-mode-host'));
    if (kind === 'host')
      writeFileSync(
        join(f.previous, 'vertex.json'),
        JSON.stringify({ ...(f.contents['vertex.json'] as object), hostId: 'another-host' }),
      );
    if (kind === 'missing') rmSync(join(f.previous, 'gemini.json'));
    if (kind === 'legacy') {
      const target: Record<string, unknown> = { ...f.target };
      delete target.continuityContract;
      writeFileSync(join(f.previous, 'codex.json'), JSON.stringify({ ...target, version: 1 }));
    }
    expect(() => prepareRuntimeDeclarations(f.next, f.source, runtime)).toThrow();
    expect(readPrivateEnvironment(join(f.next, '.env'))).toBe(f.source);
    expect(readdirSync(f.next).filter((file) => file.startsWith('.env.before-runtime-'))).toEqual(
      [],
    );
  },
);
it('does not infer or enable targets for disabled routes', () => {
  const f = fixture();
  const source = 'SECRET=unchanged\n';
  writeFileSync(join(f.next, '.env'), source);
  expect(prepareRuntimeDeclarations(f.next, source, runtime)).toEqual({
    changed: false,
    targets: [],
  });
  expect(readdirSync(f.next)).toEqual(['.env']);
});
it.each(['symlink', 'permissions', 'directory', 'changed-env'])(
  'rejects unsafe %s metadata without activation',
  (kind) => {
    const f = fixture();
    if (kind === 'symlink') {
      rmSync(join(f.previous, 'codex.json'));
      symlinkSync(join(f.previous, 'vertex.json'), join(f.previous, 'codex.json'));
    }
    if (kind === 'permissions') chmodSync(join(f.previous, 'codex-native.json'), 0o644);
    if (kind === 'directory') symlinkSync(f.previous, join(f.next, '.runtime-targets'));
    if (kind === 'changed-env') writeFileSync(join(f.next, '.env'), f.source + 'NEW_SETTING=1\n');
    expect(() => prepareRuntimeDeclarations(f.next, f.source, runtime)).toThrow();
  },
);
it('read-only validation catches later damage instead of rewriting its authority', () => {
  const f = fixture();
  prepareRuntimeDeclarations(f.next, f.source, runtime);
  const source = readPrivateEnvironment(join(f.next, '.env'));
  const file = f.env().MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.runtimeContractRevision = 'stale';
  writeFileSync(file, JSON.stringify(config));
  expect(() => checkRuntimeDeclarations(f.env(), runtime)).toThrow();
  expect(readPrivateEnvironment(join(f.next, '.env'))).toBe(source);
});
it('fails deployment before replacing launchd configuration or stopping the service', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-runtime-order-')));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'scripts/deploy.sh'), readFileSync('scripts/deploy.sh'));
  writeFileSync(join(root, 'scripts/assert-deployable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const calls = join(root, 'calls');
  for (const name of ['node', 'npm', 'launchctl', 'podman', 'docker', 'sed'])
    writeFileSync(
      join(root, 'bin', name),
      `#!/bin/sh\necho '${name}' "$@" >> '${calls}'\ncase "$*" in *release-runtime-declarations.mjs*) exit 77;; esac\nexit 0\n`,
      { mode: 0o755 },
    );
  const result = spawnSync('bash', [join(root, 'scripts/deploy.sh')], {
    encoding: 'utf8',
    env: { PATH: join(root, 'bin') + ':' + process.env.PATH, HOME: root },
  });
  expect(result.status).toBe(77);
  const observed = readFileSync(calls, 'utf8');
  expect(observed).toContain('npm run build:server');
  expect(observed).toContain('node scripts/release-runtime-declarations.mjs --prepare');
  expect(observed).not.toMatch(/launchctl|podman|docker|sed/);
  const start = readFileSync('scripts/start.sh', 'utf8');
  const check = start.indexOf('release-runtime-declarations.mjs --check');
  const launch = start.indexOf('exec node dist/index.js');
  expect(check).toBeGreaterThanOrEqual(0);
  expect(launch).toBeGreaterThanOrEqual(0);
  expect(check).toBeLessThan(launch);
});

it.each(['disabled', 'plist-selector', 'shell-selector', 'dotenv-override', 'private-env'])(
  'checks the actual CLI environment and redacts diagnostics: %s',
  (kind) => {
    const f = fixture();
    mkdirSync(join(f.next, 'scripts'));
    mkdirSync(join(f.next, 'scripts/lib'));
    for (const file of [
      'release-runtime-declarations.mjs',
      'lib/release-runtime-declarations.mjs',
      'lib/release-openshell-source.mjs',
    ])
      writeFileSync(join(f.next, 'scripts', file), readFileSync(join('scripts', file)));
    symlinkSync(realpathSync('node_modules'), join(f.next, 'node_modules'));
    let source = 'SECRET=never-print-this-secret\n';
    if (kind === 'dotenv-override') source += 'DOTENV_CONFIG_PATH=never-print-this-secret\n';
    writeFileSync(join(f.next, '.env'), source);
    if (kind === 'private-env') chmodSync(join(f.next, '.env'), 0o644);
    writeFileSync(
      join(f.next, 'com.mitzo.server.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict>${kind === 'plist-selector' ? '<key>MITZO_ORDINARY_LOCAL_CODEX_ENABLED</key><string>1</string>' : ''}</dict></dict></plist>`,
    );
    const result = spawnSync(
      process.execPath,
      [join(f.next, 'scripts/release-runtime-declarations.mjs'), '--check'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...(kind === 'shell-selector' ? { MITZO_ORDINARY_LOCAL_CODEX_ENABLED: '1' } : {}),
        },
      },
    );
    expect(result.status).toBe(kind === 'disabled' ? 0 : 1);
    expect(result.stdout + result.stderr).not.toContain('never-print-this-secret');
    if (kind !== 'disabled') expect(result.stderr).toContain('local_runtime_declarations_invalid');
  },
);

it('keeps generated credential copies and declarations out of Git discovery', () => {
  const f = fixture();
  writeFileSync(join(f.next, '.gitignore'), readFileSync('.gitignore'));
  execFileSync('git', ['init', '--quiet', f.next]);
  prepareRuntimeDeclarations(f.next, f.source, runtime);
  writeFileSync(join(f.next, '.env.runtime-interrupted'), 'private temporary settings');
  const untracked = execFileSync(
    'git',
    ['-C', f.next, 'ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  expect(untracked).toEqual(['.gitignore']);
});
