import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import {
  ordinaryOpenShellCodexContractRevision,
  loadOrdinaryOpenShellCodexTarget,
} from '../ordinary-openshell-codex-entry-owner.js';
const boundaries = vi.hoisted(() => ({ config: undefined as OpenShellRuntimeConfig | undefined }));
vi.mock('../openshell-runtime.js', async (original) => ({
  ...(await original<typeof import('../openshell-runtime.js')>()),
  openShellRuntimeConfig: () => boundaries.config,
  // Seed qualification is separately covered by the existing runtime stack tests.
  verifiedOpenShellSeed: vi.fn((config) => config.seed),
}));
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  boundaries.config = undefined;
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-openshell-target-')));
  roots.push(root);
  const cli = join(root, 'openshell');
  const policy = join(root, 'policy.yaml');
  const selector = join(root, 'target.json');
  const binary = Buffer.concat([
    Buffer.from('cffaedfe', 'hex'),
    Buffer.from('offline fixture, never executed'),
  ]);
  writeFileSync(cli, binary, { mode: 0o700 });
  writeFileSync(policy, 'version: 1\n', { mode: 0o600 });
  boundaries.config = {
    cli,
    image: 'fixture-image',
    policy,
    seed: join(root, 'seed'),
    seedStackManifest: {
      policy: { sha256: createHash('sha256').update(readFileSync(policy)).digest('hex') },
    },
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 24,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled',
  };
  const contract = ordinaryOpenShellCodexContractRevision(
    boundaries.config,
    createHash('sha256').update(binary).digest('hex'),
  );
  writeFileSync(
    selector,
    JSON.stringify({
      version: 1,
      targetId: 'target',
      runtimeContractRevision: contract,
      openaiApi: 'disabled',
    }),
    { mode: 0o600 },
  );
  return {
    root,
    cli,
    policy,
    selector,
    env: { MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE: selector },
  };
}
it('reads one private explicit selector and measured reviewed runtime without allocating a resource', () => {
  const f = fixture();
  expect(loadOrdinaryOpenShellCodexTarget(f.env)?.target).toMatchObject({
    targetId: 'target',
    location: 'openshell',
  });
  expect(loadOrdinaryOpenShellCodexTarget({})).toBeUndefined();
});
it.each(['permissions', 'symlink', 'parent', 'contract', 'binary', 'policy', 'legacy'])(
  'rejects %s selector/runtime drift',
  (kind) => {
    const f = fixture();
    if (kind === 'permissions') chmodSync(f.selector, 0o644);
    if (kind === 'symlink') {
      const link = join(f.root, 'selector-link');
      symlinkSync(f.selector, link);
      f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE = link;
    }
    if (kind === 'parent') {
      const link = join(f.root, 'parent-link');
      symlinkSync(f.root, link);
      f.env.MITZO_ORDINARY_OPENSHELL_CODEX_TARGET_FILE = join(link, 'target.json');
    }
    if (kind === 'contract')
      writeFileSync(
        f.selector,
        JSON.stringify({
          version: 1,
          targetId: 'target',
          runtimeContractRevision: 'arbitrary-label',
          openaiApi: 'disabled',
        }),
      );
    if (kind === 'binary')
      writeFileSync(
        f.cli,
        Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('changed executable bytes')]),
      );
    if (kind === 'policy') writeFileSync(f.policy, 'version: 2\n');
    if (kind === 'legacy') Object.assign(f.env, { MITZO_OPENSHELL_SANDBOX_NAME: 'shared-sandbox' });
    expect(() => loadOrdinaryOpenShellCodexTarget(f.env)).toThrow('entry unavailable');
  },
);
