import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-host-preparation-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_INTERNAL_TOKEN_PATH', path.join(root, 'internal-token'));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('Offline preparation forbids external/model calls');
    }),
  );
  return {
    root,
    apiKey: 'synthetic-canonical-host-key',
    artifacts: undefined as Record<string, string> | undefined,
  };
});
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../openai-account-key-authority.js', () => ({
  openAIAccountKeyAuthority: () => ({
    assertReady: async (signal: AbortSignal) => signal.throwIfAborted(),
    resolveKey: async () => state.apiKey,
  }),
}));
vi.mock('../connections/reviewed-handler-artifacts.js', async (original) => {
  const actual = await original<typeof import('../connections/reviewed-handler-artifacts.js')>();
  return {
    ...actual,
    get reviewedHandlerSourceArtifacts() {
      return state.artifacts ?? actual.reviewedHandlerSourceArtifacts;
    },
  };
});
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import {
  OrdinaryLocalCodexHostRuntime,
  ordinaryLocalCodexHostContractRevision,
} from '../ordinary-local-codex-host-runtime.js';
import type { OrdinaryRepositoryPreparation } from '../ordinary-repository-preparation.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  state.artifacts = undefined;
  state.apiKey = 'synthetic-canonical-host-key';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  (await import('../chat.js')).eventStore.close();
  (await import('node:fs')).rmSync(state.root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Reconstruct the published v1 receipt format from synthetic current source
 * custody, including its exact known8c3 native observation. No live data. */
async function historicalV1(proof: OrdinaryRepositoryPreparation) {
  const runtime = await new OrdinaryLocalCodexHostRuntime().observe();
  const contract = digest([
    'ordinary-local-codex-host-v1',
    'v1.0.531-repository-recovery-integration',
    '24f1c83ffc3759a76095f3072edcc9fdebbe5087c874469d60e286d728160462',
    '0.160.0',
    runtime.executableSha256,
  ]);
  const targetRevision = digest([
    'ordinary-local-codex-target-v1',
    runtime.targetId,
    runtime.hostId,
    contract,
  ]);
  const saved = {
    ...proof,
    runtimeBinding: {
      ...proof.runtimeBinding,
      execution: { ...proof.runtimeBinding.execution, targetRevision },
    },
  };
  Reflect.deleteProperty(saved, 'credentialDigestVersion');
  if (proof.originalBinding.provider === 'openai-codex') {
    const configPath = process.env.MITZO_ACCOUNT_PROFILES_FILE!;
    const login = JSON.parse(readFileSync(configPath, 'utf8'))[0].credentialRef as string;
    const authPath = join(login, 'auth.json'),
      root = lstatSync(login),
      auth = lstatSync(authPath);
    saved.credentialDigest = digest({
      routingSourcePath: configPath,
      enrolledSourcePath: process.env.MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB ?? null,
      credential: {
        root: { path: login, dev: root.dev, ino: root.ino },
        auth: {
          path: authPath,
          dev: auth.dev,
          ino: auth.ino,
          digest: digest(JSON.parse(readFileSync(authPath, 'utf8'))),
        },
        native: {
          hostId: runtime.hostId,
          runtimeContractRevision: contract,
          targetId: runtime.targetId,
          targetRevision,
          executablePath: runtime.executablePath,
          executableSha256: runtime.executableSha256,
        },
      },
    });
  }
  return saved;
}
it.each([false, true])(
  'requalifies a known legacy prepared checkout through actual capture/assert without changing its proof, API=%s',
  async (api) => {
    const f = await ownedRuntimeFixture(cleanups, {
      chatRoute: true,
      localRepository: true,
      continuityV2: true,
      api,
      realPreparationAuthority: true,
      historicalPreparation: historicalV1,
    });
    const before = f.workspace.get(f.reservation.id);
    await expect(
      f.workspace.reserveHostTask({ ...f.reservation, signal: new AbortController().signal }),
    ).resolves.toBeDefined();
    expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(
      before.ordinaryPreparation,
    );
    expect(before.ordinaryPreparation?.runtimeBinding.execution.targetRevision).not.toBe(
      new OrdinaryLocalCodexHostRuntime().target().descriptor().targetRevision,
    );
  },
);
it.each([false, true])(
  'requalifies a stable v2 prepared checkout after a compatible source deployment through actual authority, API=%s',
  async (api) => {
    const f = await ownedRuntimeFixture(cleanups, {
      chatRoute: true,
      localRepository: true,
      continuityV2: true,
      api,
      realPreparationAuthority: true,
    });
    const before = f.workspace.get(f.reservation.id);
    const actual = await vi.importActual<
      typeof import('../connections/reviewed-handler-artifacts.js')
    >('../connections/reviewed-handler-artifacts.js');
    state.artifacts = {
      ...actual.reviewedHandlerSourceArtifacts,
      '../compatible-source-edit.ts': 'e'.repeat(64),
    };
    const env = f.dependencies.env!,
      targetPath = env.MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE!;
    const target = JSON.parse(readFileSync(targetPath, 'utf8')),
      native = JSON.parse(readFileSync(env.MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE!, 'utf8'));
    target.runtimeContractRevision = ordinaryLocalCodexHostContractRevision(
      native.executableSha256,
      native.codeModeHostSha256,
    );
    writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 });
    await expect(
      f.workspace.reserveHostTask({ ...f.reservation, signal: new AbortController().signal }),
    ).resolves.toBeDefined();
    expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(
      before.ordinaryPreparation,
    );
  },
);

it.each([false, true])(
  'retains legacy proof but refuses changed credentials and unknown target aliases, API=%s',
  async (api) => {
    const f = await ownedRuntimeFixture(cleanups, {
      chatRoute: true,
      localRepository: true,
      continuityV2: true,
      api,
      realPreparationAuthority: true,
      historicalPreparation: historicalV1,
    });
    const saved = f.workspace.get(f.reservation.id).ordinaryPreparation!;
    const { assertOrdinaryRepositoryPreparation } =
      await import('../ordinary-repository-preparation-authority.js');
    await expect(
      assertOrdinaryRepositoryPreparation(
        {
          ...saved,
          runtimeBinding: {
            ...saved.runtimeBinding,
            execution: { ...saved.runtimeBinding.execution, targetRevision: 'unreviewed-target' },
          },
        },
        f.reservation.binding,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    if (api) state.apiKey = 'unaccepted-rotation';
    else {
      const profile = JSON.parse(readFileSync(process.env.MITZO_ACCOUNT_PROFILES_FILE!, 'utf8'))[0];
      writeFileSync(
        join(profile.credentialRef, 'auth.json'),
        JSON.stringify({ tokens: { access_token: 'changed-unaccepted' } }),
        { mode: 0o600 },
      );
    }
    await expect(
      f.workspace.reserveHostTask({ ...f.reservation, signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(f.workspace.get(f.reservation.id).ordinaryPreparation).toEqual(saved);
  },
);
