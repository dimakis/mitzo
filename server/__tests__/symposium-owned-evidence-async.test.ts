import { it, expect, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedEvidenceCollector } from '../symposium-owned-evidence-async.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
const selection = {
  providerInstances: [{ name: 'personal', id: 'id', type: 'codex', profileName: 'codex' }],
  allowedRoles: ['reviewer'],
  allowedAccountProviders: ['openai-codex'],
  artifactVolume: { driver: 'podman', name: 'volume' },
};
function fixture(root: string) {
  const config = {
    cli: join(root, 'cli'),
    gateway: 'owned',
    workspace: 'workspace',
    policy: join(root, 'policy'),
    seed: join(root, 'seed'),
    cliEnvironment: { HOME: root, XDG_CONFIG_HOME: root, PATH: '/usr/bin:/bin' },
  } as OpenShellRuntimeConfig;
  writeFileSync(config.policy, 'policy');
  mkdirSync(config.seed);
  const physical = {
    cli: config.cli,
    podman: '/no-podman',
    cliEnv: config.cliEnvironment!,
    podmanEnv: {},
  };
  const custody = {
    verifyCustodyAsync: vi.fn(async () => {}),
    verifyOwnedNativeHostAsync: vi.fn(async () => {}),
    verifyGatewayDriverConfigAsync: vi.fn(async () => {}),
  };
  return { config, physical, custody };
}
it('real worker keeps event loop responsive during a slow CLI, fails closed, and serializes requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-worker-'));
  try {
    const f = fixture(root);
    const started = join(root, 'started');
    writeFileSync(
      f.config.cli,
      `#!/bin/sh\ntouch '${started}'\nsleep 0.3\nprintf '{"id":"codex"}\\n'\n`,
      { mode: 0o700 },
    );
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
    );
    const pending = collect(selection);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(pending).rejects.toThrow('Evidence could not be verified');
    await expect(collect(selection)).rejects.toThrow('already in progress');
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    let timer = false;
    await new Promise((resolve) =>
      setTimeout(() => {
        timer = true;
        resolve(undefined);
      }, 10),
    );
    expect(timer).toBe(true);
    expect(settled).toBe(false);
    await rejected;
    expect(f.custody.verifyCustodyAsync.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(collect(selection)).rejects.toMatchObject({
      message: 'Evidence could not be verified',
      phase: 'gate',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('waits for worker cleanup before returning and rechecks retained custody after exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-cleanup-'));
  try {
    const f = fixture(root);
    const cleaned = join(root, 'cleaned');
    const spawn = (_source: string, options: ConstructorParameters<typeof Worker>[1]) =>
      new Worker(
        `const {parentPort}=require('node:worker_threads'); parentPort.postMessage({candidate:{fixture:true}}); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(cleaned)},'cleaned'),50);`,
        { ...options, eval: true },
      );
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      spawn,
    );
    expect(await collect(selection)).toEqual({ fixture: true });
    expect(existsSync(cleaned)).toBe(true);
    f.custody.verifyCustodyAsync
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error('stopped');
      });
    await expect(collect(selection)).rejects.toThrow(
      'Evidence retained custody could not be verified',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('quarantines an abnormal worker exit instead of claiming cleanup or starting another probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-failure-'));
  try {
    const f = fixture(root);
    const spawn = vi.fn(
      (_source: string, options: ConstructorParameters<typeof Worker>[1]) =>
        new Worker(`throw new Error('worker crash');`, { ...options, eval: true }),
    );
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      spawn,
    );
    await expect(collect(selection)).rejects.toThrow('operator recovery');
    await expect(collect(selection)).rejects.toThrow('operator recovery');
    expect(spawn).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns only an allowlisted worker phase after a clean exit and never forwards raw diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-phase-'));
  try {
    const f = fixture(root);
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) =>
        new Worker(
          `const {parentPort}=require('node:worker_threads'); parentPort.postMessage({error:true, phase:'verify-image', message:'secret /private/path'});`,
          { ...options, eval: true },
        ),
    );
    await expect(collect(selection)).rejects.toMatchObject({
      message: 'Evidence could not be verified',
      phase: 'verify-image',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('ignores unrecognized worker phases and retains uncertain cleanup quarantine', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-phase-invalid-'));
  try {
    const f = fixture(root);
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) =>
        new Worker(
          `const {parentPort}=require('node:worker_threads'); parentPort.postMessage({error:true, phase:'secret /private/path', cleanupUncertain:true});`,
          { ...options, eval: true },
        ),
    );
    await expect(collect(selection)).rejects.toThrow('operator recovery');
    await expect(collect(selection)).rejects.toThrow('operator recovery');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('finishes cleanup after an HTTP client disconnect instead of terminating the worker', async () => {
  const { default: express } = await import('express');
  const { default: request } = await import('supertest');
  const { ownedEvidenceHandler } = await import('../symposium-owned-evidence.js');
  const root = mkdtempSync(join(tmpdir(), 'evidence-disconnect-'));
  try {
    const f = fixture(root);
    const cleaned = join(root, 'cleaned');
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) =>
        new Worker(
          `const {parentPort}=require('node:worker_threads'); setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(cleaned)},'cleaned'); parentPort.postMessage({error:true});},100);`,
          { ...options, eval: true },
        ),
    );
    const app = express();
    app.use(express.json());
    app.post(
      '/evidence',
      ownedEvidenceHandler(() => collect),
    );
    const client = request(app).post('/evidence').send(selection);
    client.end(() => {});
    await vi.waitFor(() => expect(f.custody.verifyCustodyAsync).toHaveBeenCalled());
    client.abort();
    await vi.waitFor(() => expect(existsSync(cleaned)).toBe(true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('forwards trusted full-build selection to its original worker and rejects request overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-build-forward-'));
  try {
    const f = fixture(root);
    let seen: unknown;
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) => {
        seen = options.workerData.buildSelection;
        return new Worker(
          `require('node:worker_threads').parentPort.postMessage({error:true,phase:'gate'});`,
          { ...options, eval: true },
        );
      },
      'local-854b-b20-v1',
    );
    await expect(collect(selection)).rejects.toMatchObject({ phase: 'gate' });
    expect(seen).toBe('local-854b-b20-v1');
    await expect(collect({ ...selection, buildSelection: 'local-854b-b20-v1' })).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('actual worker serialization excludes original trusted runtime observer without mutating host config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-runtime-observer-'));
  try {
    const f = fixture(root);
    const observeRuntime = vi.fn();
    f.config.observeRuntime = observeRuntime;
    let wireConfig: unknown;
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) => {
        wireConfig = options.workerData.config;
        return new Worker(
          `const {workerData,parentPort}=require('node:worker_threads');
          if(Object.hasOwn(workerData.config,'observeRuntime'))throw Error('Trusted callback crossed worker wire');
          parentPort.postMessage({candidate:{fixture:true}});`,
          { ...options, eval: true },
        );
      },
    );
    expect(await collect(selection)).toEqual({ fixture: true });
    expect(wireConfig).not.toHaveProperty('observeRuntime');
    expect(wireConfig).toMatchObject({
      cli: f.config.cli,
      workspace: f.config.workspace,
      cliEnvironment: f.config.cliEnvironment,
    });
    expect(f.config.observeRuntime).toBe(observeRuntime);
    f.config.observeRuntime({
      kind: 'ensure-phase',
      phase: 'sandbox-current',
      stage: 'start',
      elapsedMs: 0,
      error: 'none',
    });
    expect(observeRuntime).toHaveBeenCalledOnce();
    expect(f.custody.verifyCustodyAsync.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('worker serialization still refuses unrelated function fields instead of broad callback filtering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-unknown-function-'));
  try {
    const f = fixture(root);
    f.config.observeRuntime = vi.fn();
    Object.assign(f.config, { unknownWireCallback: () => {} });
    const collect = createOwnedEvidenceCollector(
      f.config,
      'https://localhost:1234',
      f.physical,
      f.custody,
      (_source, options) =>
        new Worker(
          `require('node:worker_threads').parentPort.postMessage({candidate:{fixture:true}});`,
          { ...options, eval: true },
        ),
    );
    await expect(collect(selection)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(f.config.observeRuntime).toBeTypeOf('function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
