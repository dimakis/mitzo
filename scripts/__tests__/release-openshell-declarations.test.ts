import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as codex from '../../server/ordinary-local-codex-host-runtime.js';
import * as responses from '../../server/ordinary-local-responses-capabilities.js';
import * as vertex from '../../server/ordinary-local-vertex-capabilities.js';
import * as openshell from '../../server/ordinary-openshell-codex-entry-owner.js';
import * as shell from '../../server/openshell-runtime.js';
import * as native from '../../server/frozen-host-codex-executable.js';
import { ordinaryOpenShellCodexTarget } from '../../server/ordinary-openshell-codex-route.js';
import { SUPPORTED_CODEX_CLI_VERSION } from '../../server/codex-app-server-client.js';
import {
  prepareRuntimeDeclarations,
  checkRuntimeDeclarations,
  readPrivateEnvironment,
} from '../lib/release-runtime-declarations.mjs';
import { readAcceptedOpenShellSource } from '../lib/release-openshell-source.mjs';
import { parse } from 'dotenv';
const runtime = { codex, responses, vertex, openshell, shell, native };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-shell-')));
  roots.push(root);
  const previous = join(root, 'previous'),
    candidate = join(root, 'candidate');
  for (const p of [previous, candidate, join(previous, '.runtime-targets')])
    mkdirSync(p, { mode: 0o700 });
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', candidate, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'utf8' },
    ).trim();
  git('init', '--quiet');
  mkdirSync(join(candidate, 'server/connections'), { recursive: true });
  mkdirSync(join(candidate, 'docs/spikes/openshell-codex'), { recursive: true });
  const revision = 'previous-reviewed-release',
    artifacts = { '../offline.ts': 'a'.repeat(64) };
  const manifest =
    "export const reviewedConnectionsRuntimeImplementationRevision = '" +
    revision +
    "';\nexport const reviewedHandlerSourceArtifacts = Object.freeze({\n  '../offline.ts': '" +
    'a'.repeat(64) +
    "',\n});\n";
  writeFileSync(join(candidate, 'server/connections/reviewed-handler-artifacts.ts'), manifest);
  writeFileSync(
    join(candidate, 'docs/spikes/openshell-codex/runtime-codex-version'),
    SUPPORTED_CODEX_CLI_VERSION,
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'accepted previous source',
  );
  const commit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', commit);
  writeFileSync(
    join(previous, 'release.txt'),
    `source_commit=${commit}\nsource_tree=${git('rev-parse', 'HEAD^{tree}')}\n`,
  );
  const cli = join(previous, 'openshell'),
    policy = join(previous, 'policy.yaml'),
    stack = join(previous, 'stack.json');
  const bytes = Buffer.concat([
    Buffer.from('cffaedfe', 'hex'),
    Buffer.from('synthetic CLI, never executed'),
  ]);
  writeFileSync(cli, bytes, { mode: 0o700 });
  writeFileSync(policy, 'version: 1\n', { mode: 0o600 });
  const seedStackManifest = {
    policy: { sha256: createHash('sha256').update(readFileSync(policy)).digest('hex') },
  };
  writeFileSync(stack, JSON.stringify(seedStackManifest));
  const env = {
    MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED: '1',
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_CLI: cli,
    MITZO_OPENSHELL_IMAGE: 'fixture-image',
    MITZO_OPENSHELL_POLICY: policy,
    MITZO_OPENSHELL_SEED: join(previous, 'seed'),
    MITZO_OPENSHELL_STACK_MANIFEST: stack,
    MITZO_OPENSHELL_WEB_SEARCH: 'disabled',
    OPENSHELL_GATEWAY: 'original-gateway',
    OPENSHELL_WORKSPACE: 'original-workspace',
    MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE: join(previous, '.runtime-targets/openshell.json'),
  };
  const cliSha256 = createHash('sha256').update(bytes).digest('hex');
  const declaration = {
    version: 1,
    targetId: 'original-shell',
    openaiApi: 'disabled' as const,
    runtimeContractRevision: hash([
      'ordinary-openshell-codex-owner-v1',
      revision,
      Object.entries(artifacts),
      SUPPORTED_CODEX_CLI_VERSION,
      cliSha256,
      env.MITZO_OPENSHELL_IMAGE,
      seedStackManifest,
    ]),
  };
  writeFileSync(env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE, JSON.stringify(declaration), {
    mode: 0o600,
  });
  const source =
    Object.entries(env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join('\n') + '\nSECRET=synthetic-only\n';
  writeFileSync(join(candidate, '.env'), source, { mode: 0o600 });
  return { candidate, previous, env, source, declaration, cli, policy, stack, commit, git };
}
it('renews an OpenShell-only release after proving its original accepted CLI contract and preserves its target identity', () => {
  const f = fixture();
  expect(() => openshell.loadOrdinaryOpenShellCodexTarget(f.env)).toThrow();
  expect(() => checkRuntimeDeclarations(f.env, runtime)).toThrow();
  const target = ordinaryOpenShellCodexTarget({
    ...f.declaration,
    config: shell.openShellRuntimeConfig(f.env)!,
  });
  const result = prepareRuntimeDeclarations(f.candidate, f.source, runtime);
  expect(result.changed).toBe(true);
  expect(result.targets).toEqual([target]);
  const renewed = parse(readPrivateEnvironment(join(f.candidate, '.env')));
  expect(openshell.loadOrdinaryOpenShellCodexTarget(renewed)?.target).toEqual(target);
  expect(
    renewed.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE.startsWith(
      join(f.candidate, '.runtime-targets') + '/',
    ),
  ).toBe(true);
  expect({
    ...renewed,
    MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE: f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE,
  }).toEqual({ ...f.env, SECRET: 'synthetic-only' });
  expect(
    JSON.parse(readFileSync(f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE, 'utf8')),
  ).toEqual(f.declaration);
  const unchanged = readPrivateEnvironment(join(f.candidate, '.env'));
  expect(prepareRuntimeDeclarations(f.candidate, unchanged, runtime).changed).toBe(false);
});
it.each([
  'binary',
  'policy',
  'stack',
  'unaccepted',
  'missing-release',
  'unsafe-selector',
  'changed-source',
])('refuses %s drift without rewriting the environment', (kind) => {
  const f = fixture();
  if (kind === 'binary')
    writeFileSync(
      f.cli,
      Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('changed CLI')]),
    );
  if (kind === 'policy') writeFileSync(f.policy, 'version: 2\n');
  if (kind === 'stack')
    writeFileSync(f.stack, JSON.stringify({ policy: { sha256: 'b'.repeat(64) } }));
  if (kind === 'unaccepted') f.git('update-ref', '-d', 'refs/remotes/origin/main');
  if (kind === 'missing-release') rmSync(join(f.previous, 'release.txt'));
  if (kind === 'unsafe-selector')
    chmodSync(f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE, 0o644);
  if (kind === 'changed-source')
    writeFileSync(join(f.previous, 'release.txt'), 'source_commit=' + 'b'.repeat(40) + '\n');
  expect(() => prepareRuntimeDeclarations(f.candidate, f.source, runtime)).toThrow();
  expect(readPrivateEnvironment(join(f.candidate, '.env'))).toBe(f.source);
});
it('reads prior source only from accepted Git objects, never from executable release files', () => {
  const f = fixture();
  mkdirSync(join(f.previous, 'server/connections'), { recursive: true });
  writeFileSync(
    join(f.previous, 'server/connections/reviewed-handler-artifacts.ts'),
    'throw new Error("do not execute or trust me")',
  );
  expect(
    readAcceptedOpenShellSource(f.candidate, f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE)
      .revision,
  ).toBe('previous-reviewed-release');
});
