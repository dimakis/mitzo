import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

let root = '';
const baseImage = `registry.invalid/runtime@sha256:${'a'.repeat(64)}`;

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
    `version = 1\nrevision = 1\nrequires-python = ">=3.11"\n\n[[package]]\nname = "fixture"\nversion = "0"\nsource = { editable = "." }\n\n[[package]]\nname = "direct"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\n\n[[package]]\nname = "nested"\nversion = "1"\nsource = { registry = "${nestedSource}" }\ndependencies = [{ name = "transitive" }]\n\n[[package]]\nname = "transitive"\nversion = "1"\nsource = { registry = "https://packages.example/simple" }\n`,
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
