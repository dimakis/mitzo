import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { canonicalJsonPayload } from '../../scripts/verify-openshell-production.mjs';

let root = '';
const baseImage = `registry.invalid/runtime@sha256:${'a'.repeat(64)}`;
const markerEnvironmentB64 = Buffer.from(
  JSON.stringify({
    implementation_name: 'cpython',
    implementation_version: '3.11.9',
    os_name: 'posix',
    platform_machine: 'x86_64',
    platform_release: 'fixture',
    platform_system: 'Linux',
    platform_version: 'fixture',
    platform_python_implementation: 'CPython',
    python_full_version: '3.11.9',
    python_version: '3.11',
    sys_platform: 'linux',
  }),
).toString('base64');

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function contract({
  requiresPython = '>=3.11',
  marker = "sys_platform == 'linux'",
  source = 'https://packages.example/simple',
} = {}) {
  root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-'));
  writeFileSync(
    join(root, 'pyproject.toml'),
    `[project]\nname = "fixture"\nversion = "0"\nrequires-python = "${requiresPython}"\ndependencies = ["runtime==1"]\n`,
  );
  writeFileSync(
    join(root, 'uv.lock'),
    `version = 1\nrevision = 1\nrequires-python = "${requiresPython}"\nresolution-markers = ["${marker}"]\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "runtime", marker = "${marker}" }]\n\n[[package]]\nname = "runtime"\nversion = "1"\nsource = { registry = "${source}" }\nsdist = { url = "${source}/runtime-1.tar.gz", hash = "sha256:one" }\n`,
  );
  return execFileSync(
    'python3',
    [
      resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
      '--pyproject',
      join(root, 'pyproject.toml'),
      '--lock',
      join(root, 'uv.lock'),
      '--base-image',
      baseImage,
      '--target-platform',
      'linux/amd64',
      '--target-marker-environment-b64',
      markerEnvironmentB64,
      '--sha256',
    ],
    { encoding: 'utf8' },
  ).trim();
}

function groupedContract(groups: string, nestedSource = 'https://packages.example/simple') {
  root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-groups-'));
  writeFileSync(
    join(root, 'pyproject.toml'),
    `[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\n\n[tool.uv]\ndefault-groups = ["runtime"]\n\n[dependency-groups]\nruntime = ["direct==1", { include-group = "nested" }]\nnested = ${groups}\n`,
  );
  writeFileSync(
    join(root, 'uv.lock'),
    `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\n\n[[package]]\nname = "direct"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\noptional-dependencies = { extra = [] }\n\n[[package]]\nname = "nested"\nversion = "1"\nsource = { registry = "${nestedSource}" }\ndependencies = [{ name = "transitive" }]\n\n[[package]]\nname = "transitive"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\n`,
  );
  return execFileSync(
    'python3',
    [
      resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
      '--pyproject',
      join(root, 'pyproject.toml'),
      '--lock',
      join(root, 'uv.lock'),
      '--base-image',
      baseImage,
      '--target-platform',
      'linux/amd64',
      '--target-marker-environment-b64',
      markerEnvironmentB64,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

it('canonical contract changes for markers, Python constraints, and package source identity', () => {
  const baseline = contract();
  const marker = contract({ marker: "sys_platform == 'darwin'" });
  const python = contract({ requiresPython: '>=3.12' });
  expect(marker).not.toBe(baseline);
  expect(python).not.toBe(baseline);
  const source = contract({ source: 'https://other.example/simple' });
  expect(source).not.toBe(baseline);
});

it('uses byte-identical UTF-8 canonical JSON in Python and Node', () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-unicode-'));
  writeFileSync(
    join(root, 'pyproject.toml'),
    '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\ndependencies = ["runtime==1"]\n',
  );
  writeFileSync(
    join(root, 'uv.lock'),
    `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "runtime" }]\nmetadata = { "Ω-path" = "café" }\n\n[[package]]\nname = "runtime"\nversion = "1"\nsource = { registry = "https://packages.example/é" }\nsdist = { url = "https://packages.example/é/runtime-1.tar.gz", hash = "sha256:one" }\n`,
  );
  const python = execFileSync(
    'python3',
    [
      resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
      '--pyproject',
      join(root, 'pyproject.toml'),
      '--lock',
      join(root, 'uv.lock'),
      '--base-image',
      baseImage,
      '--target-platform',
      'linux/amd64',
      '--target-marker-environment-b64',
      markerEnvironmentB64,
    ],
    { encoding: 'utf8' },
  );
  expect(Buffer.from(python, 'utf8')).toEqual(
    Buffer.from(`${canonicalJsonPayload(JSON.parse(python))}\n`, 'utf8'),
  );
  expect(createHash('sha256').update(python, 'utf8').digest('hex')).toBe(
    createHash('sha256')
      .update(`${canonicalJsonPayload(JSON.parse(python))}\n`, 'utf8')
      .digest('hex'),
  );
});

it('excludes dev-only root metadata but retains runtime dependency and source changes', () => {
  const noDevContract = (devVersion: string, runtimeSource: string) => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-no-dev-'));
    writeFileSync(
      join(root, 'pyproject.toml'),
      `[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\ndependencies = ["runtime==1"]\n\n[tool.uv]\ndev-dependencies = ["dev==${devVersion}"]\n\n[tool.uv.sources]\nruntime = { index = "runtime" }\n`,
    );
    writeFileSync(
      join(root, 'uv.lock'),
      `version = 1\nrevision = 1\nrequires-python = ">=3.11"\noptions = { exclude-newer = "2026-01-01" }\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "runtime" }]\n\n[package.dev-dependencies]\ndev = [{ name = "dev" }]\n\n[[package]]\nname = "runtime"\nversion = "1"\nsource = { registry = "${runtimeSource}" }\n\n[[package]]\nname = "dev"\nversion = "${devVersion}"\nsource = { registry = "https://packages.example/dev" }\n`,
    );
    return execFileSync(
      'python3',
      [
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        '--pyproject',
        join(root, 'pyproject.toml'),
        '--lock',
        join(root, 'uv.lock'),
        '--base-image',
        baseImage,
        '--target-platform',
        'linux/amd64',
        '--target-marker-environment-b64',
        markerEnvironmentB64,
      ],
      { encoding: 'utf8' },
    );
  };
  const baseline = noDevContract('1', 'https://packages.example/runtime');
  const devOnly = noDevContract('2', 'https://packages.example/runtime');
  const runtimeChanged = noDevContract('2', 'https://packages.example/runtime-new');
  expect(devOnly).toBe(baseline);
  expect(runtimeChanged).not.toBe(baseline);
});

it('follows the platform-qualified lock edge instead of every same-name variant', () => {
  const qualifiedContract = (darwinVersion: string, linuxVersion = '1') => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-qualified-'));
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\ndependencies = ["shared"]\n',
    );
    writeFileSync(
      join(root, 'uv.lock'),
      `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "shared", version = "${linuxVersion}", marker = "sys_platform == 'linux'" }, { name = "shared", version = "${darwinVersion}", marker = "sys_platform == 'darwin'" }]\n\n[[package]]\nname = "shared"\nversion = "${linuxVersion}"\nsource = { registry = "https://packages.example/linux" }\n\n[[package]]\nname = "shared"\nversion = "${darwinVersion}"\nsource = { registry = "https://packages.example/darwin" }\n`,
    );
    return execFileSync(
      'python3',
      [
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        '--pyproject',
        join(root, 'pyproject.toml'),
        '--lock',
        join(root, 'uv.lock'),
        '--base-image',
        baseImage,
        '--target-platform',
        'linux/amd64',
        '--target-marker-environment-b64',
        markerEnvironmentB64,
      ],
      { encoding: 'utf8' },
    );
  };
  expect(qualifiedContract('2')).toBe(qualifiedContract('3'));
  expect(qualifiedContract('2')).not.toBe(qualifiedContract('2', '4'));
});

it('includes only the requested optional-dependency closure', () => {
  const withExtras = (selectedVersion: string, unusedVersion: string) => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-extras-'));
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\ndependencies = ["feature[search]==1"]\n',
    );
    writeFileSync(
      join(root, 'uv.lock'),
      `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "feature", version = "1", extra = ["search"] }]\n\n[[package]]\nname = "feature"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\noptional-dependencies = { search = [{ name = "selected", version = "${selectedVersion}", marker = "extra == 'search'" }], unused = [{ name = "unused", version = "${unusedVersion}", marker = "extra == 'unused'" }] }\n\n[[package]]\nname = "selected"\nversion = "${selectedVersion}"\nsource = { registry = "https://packages.example/selected-${selectedVersion}" }\n\n[[package]]\nname = "unused"\nversion = "${unusedVersion}"\nsource = { registry = "https://packages.example/unused-${unusedVersion}" }\n`,
    );
    return execFileSync(
      'python3',
      [
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        '--pyproject',
        join(root, 'pyproject.toml'),
        '--lock',
        join(root, 'uv.lock'),
        '--base-image',
        baseImage,
        '--target-platform',
        'linux/amd64',
        '--target-marker-environment-b64',
        markerEnvironmentB64,
        '--sha256',
      ],
      { encoding: 'utf8' },
    ).trim();
  };
  const baseline = withExtras('1', '1');
  expect(withExtras('1', '2')).toBe(baseline);
  expect(withExtras('2', '2')).not.toBe(baseline);
});

it('uses the supplied target Python marker environment instead of host defaults', () => {
  const python312 = Buffer.from(
    JSON.stringify({
      implementation_name: 'cpython',
      implementation_version: '3.12.1',
      os_name: 'posix',
      platform_machine: 'x86_64',
      platform_release: 'fixture',
      platform_system: 'Linux',
      platform_version: 'fixture',
      platform_python_implementation: 'CPython',
      python_full_version: '3.12.1',
      python_version: '3.12',
      sys_platform: 'linux',
    }),
  ).toString('base64');
  root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-marker-'));
  writeFileSync(
    join(root, 'pyproject.toml'),
    '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\ndependencies = ["runtime"]\n',
  );
  writeFileSync(
    join(root, 'uv.lock'),
    'version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\ndependencies = [{ name = "runtime", marker = "python_version >= \'3.12\'" }]\n\n[[package]]\nname = "runtime"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\n',
  );
  const run = (environment: string) =>
    execFileSync(
      'python3',
      [
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        '--pyproject',
        join(root, 'pyproject.toml'),
        '--lock',
        join(root, 'uv.lock'),
        '--base-image',
        baseImage,
        '--target-platform',
        'linux/amd64',
        '--target-marker-environment-b64',
        environment,
      ],
      { encoding: 'utf8' },
    );
  expect(
    JSON.parse(run(markerEnvironmentB64)).lock.packages.map(
      (entry: { name: string }) => entry.name,
    ),
  ).toEqual(['fixture']);
  expect(
    JSON.parse(run(python312))
      .lock.packages.map((entry: { name: string }) => entry.name)
      .sort(),
  ).toEqual(['fixture', 'runtime']);
});

it('loads the declared tomli fallback when tomllib is unavailable', () => {
  const tool = resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py');
  execFileSync('python3', [
    '-c',
    `
import builtins, sys, types, tomllib as native_tomllib
real_import = builtins.__import__
def import_without_tomllib(name, *args, **kwargs):
    if name == 'tomllib':
        raise ModuleNotFoundError(name)
    return real_import(name, *args, **kwargs)
builtins.__import__ = import_without_tomllib
sys.modules['tomli'] = types.SimpleNamespace(load=native_tomllib.load, loads=native_tomllib.loads)
namespace = {'__name__': 'runtime_resolution_contract_test'}
exec(compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec'), namespace)
assert namespace['tomllib'] is sys.modules['tomli']
`,
    tool,
  ]);
  expect(
    readFileSync(resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh'), 'utf8'),
  ).toContain("--with 'tomli==2.2.1' --with 'packaging==24.2'");
  expect(
    readFileSync(resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), 'utf8'),
  ).toContain("--with 'tomli==2.2.1' --with 'packaging==24.2'");
});

it('accepts complete PEP 508 dependency-group requirements and filters their markers', () => {
  const selected = JSON.parse(
    groupedContract(
      '["nested>=1,<2", "direct[extra] ; sys_platform == \'linux\'", "transitive @ https://packages.example/transitive.whl"]',
    ),
  );
  expect(selected.lock.packages.map((entry: { name: string }) => entry.name).sort()).toEqual([
    'direct',
    'fixture',
    'nested',
    'transitive',
  ]);
  const unselected = JSON.parse(groupedContract('["nested ; sys_platform == \'darwin\'"]'));
  expect(unselected.lock.packages.map((entry: { name: string }) => entry.name).sort()).toEqual([
    'direct',
    'fixture',
  ]);
  expect(() => groupedContract('["@@"]')).toThrow('unsupported dependency-group requirement');
});

it('recursively includes selected PEP 735 groups and their lock closure', () => {
  const contract = JSON.parse(groupedContract('["nested==1"]'));
  expect(contract.project.selectedDependencyGroups).toEqual({
    runtime: ['direct==1', 'nested==1'],
  });
  expect(contract.lock.packages.map((entry: { name: string }) => entry.name).sort()).toEqual([
    'direct',
    'fixture',
    'nested',
    'transitive',
  ]);
  const baseline = groupedContract('["nested==1"]');
  const changed = groupedContract('["nested==1"]', 'https://other.example/simple');
  expect(changed).not.toBe(baseline);
});

it('follows qualified uv.lock default-group edges instead of universal variants', () => {
  const contractFor = (linuxVersion: string, darwinVersion: string) => {
    root = mkdtempSync(join(tmpdir(), 'mitzo-resolution-contract-group-variants-'));
    writeFileSync(
      join(root, 'pyproject.toml'),
      '[project]\nname = "fixture"\nversion = "0"\nrequires-python = ">=3.11"\n\n[tool.uv]\ndefault-groups = ["runtime"]\n\n[dependency-groups]\nruntime = ["shared"]\n',
    );
    writeFileSync(
      join(root, 'uv.lock'),
      `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\n\n[package.dev-dependencies]\nruntime = [{ name = "shared", version = "${linuxVersion}", marker = "sys_platform == 'linux'" }, { name = "shared", version = "${darwinVersion}", marker = "sys_platform == 'darwin'" }]\n\n[[package]]\nname = "shared"\nversion = "${linuxVersion}"\nsource = { registry = "https://packages.example/linux" }\n\n[[package]]\nname = "shared"\nversion = "${darwinVersion}"\nsource = { registry = "https://packages.example/darwin" }\n`,
    );
    return execFileSync(
      'python3',
      [
        resolve('docs/spikes/openshell-codex/runtime-resolution-contract.py'),
        '--pyproject',
        join(root, 'pyproject.toml'),
        '--lock',
        join(root, 'uv.lock'),
        '--base-image',
        baseImage,
        '--target-platform',
        'linux/amd64',
        '--target-marker-environment-b64',
        markerEnvironmentB64,
        '--sha256',
      ],
      { encoding: 'utf8' },
    ).trim();
  };
  const baseline = contractFor('1', '2');
  expect(contractFor('1', '3')).toBe(baseline);
  expect(contractFor('4', '3')).not.toBe(baseline);
});

it('rejects missing and cyclic selected PEP 735 groups', () => {
  expect(() => groupedContract('[{ include-group = "missing" }]')).toThrow('missing');
  expect(() => groupedContract('[{ include-group = "runtime" }]')).toThrow('cycle');
});

it('uses the builder contract output key verbatim as the seed release input', () => {
  const builder = readFileSync(
    resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh'),
    'utf8',
  );
  const seed = readFileSync(resolve('docs/spikes/openshell-codex/prepare-mgmt-seed.sh'), 'utf8');
  expect(builder).toContain('MGMT_RUNTIME_DEPENDENCY_PROJECTION_SHA256=');
  expect(seed).toContain('MGMT_RUNTIME_DEPENDENCY_PROJECTION_SHA256:-');
  expect(builder).toContain('MGMT_RUNTIME_BASE_IMAGE=');
  expect(seed).toContain('MGMT_RUNTIME_BASE_IMAGE:-');
  expect(builder).toContain('MGMT_RUNTIME_TARGET_PLATFORM=');
  expect(seed).toContain('MGMT_RUNTIME_TARGET_PLATFORM:-');
});
