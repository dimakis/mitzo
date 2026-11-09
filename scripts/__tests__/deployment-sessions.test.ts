import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deploymentBase,
  reconcileDeployment,
  type DeploymentAction,
} from '../deployment-sessions.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-deploy-cli-'));
  directories.push(directory);
  const tokenPath = join(directory, 'operator'),
    statePath = join(directory, 'state');
  writeFileSync(tokenPath, 'signed-operator-token', { mode: 0o600 });
  const calls: Array<{ path: string; body?: { id: string; targetCommit?: string } }> = [];
  const target = 'b'.repeat(40),
    source = 'a'.repeat(40);
  let commit = source,
    ready = true,
    phase = 'pausing';
  const fetcher = async (url: string, input: RequestInit) => {
    expect(input.redirect).toBe('error');
    expect(input.headers).toMatchObject({ authorization: 'Bearer signed-operator-token' });
    const path = new URL(url).pathname,
      body = input.body ? JSON.parse(input.body as string) : undefined;
    calls.push({ path, body });
    const value =
      path === '/api/version'
        ? { commit }
        : path === '/api/service-health'
          ? {
              checkedAt: Date.now(),
              services: [
                { name: 'yapper', ok: ready },
                { name: 'contexgin', ok: ready },
              ],
            }
          : path === '/api/deployment'
            ? {
                protocol: 1,
                active: {
                  id: calls.find((call) => call.path.endsWith('/begin'))?.body?.id,
                  phase,
                  sessions: [],
                },
              }
            : path.endsWith('/pause')
              ? { operation: { id: body.id, phase: (phase = 'paused'), sessions: [] } }
              : path.endsWith('/resume')
                ? { operation: { id: body.id, phase: (phase = 'completed'), sessions: [] } }
                : { operation: { id: body?.id, phase, sessions: [] } };
    return { ok: true, json: async () => value } as Response;
  };
  const run = (action: DeploymentAction, options = {}) =>
    reconcileDeployment({
      action,
      targetCommit: target,
      statePath,
      tokenPath,
      fetcher,
      ...options,
    });
  return {
    run,
    calls,
    statePath,
    target,
    source,
    commit: (value: string) => {
      commit = value;
    },
    unhealthy: () => {
      ready = false;
    },
  };
}
it('restricts signed credentials to the explicit local production API with no redirects', () => {
  expect(deploymentBase('http://127.0.0.1:3101')).toBe('http://127.0.0.1:3101');
  for (const base of [
    'http://mitzo-staging.localhost:3190',
    'https://example.com',
    'http://127.0.0.1:3101/elsewhere',
    'http://operator:secret@127.0.0.1:3101',
  ])
    expect(() => deploymentBase(base)).toThrow();
});
it('retains one operation identity and separates health proof from continuation', async () => {
  const f = fixture();
  await f.run('prepare');
  await f.run('activate');
  const original = JSON.parse(readFileSync(f.statePath, 'utf8'));
  f.commit(f.target);
  await f.run('health');
  expect(f.calls.some((call) => call.path.endsWith('/resume'))).toBe(false);
  await f.run('resume');
  expect(f.calls.find((call) => call.path.endsWith('/resume'))!.body).toMatchObject({
    id: original.id,
    activationId: original.activationId,
  });
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).phase).toBe('completed');
});
it('never resumes an unexpected or unhealthy release and retains the ledger', async () => {
  const f = fixture();
  await f.run('prepare');
  f.commit('c'.repeat(40));
  let clock = Date.now();
  await expect(
    f.run('resume', {
      now: () => clock,
      wait: async () => {
        clock += 61_000;
      },
    }),
  ).rejects.toThrow(/healthy/);
  expect(f.calls.some((call) => call.path.endsWith('/resume'))).toBe(false);
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).phase).toBe('paused');
  f.commit(f.target);
  f.unhealthy();
  clock = Date.now();
  await expect(
    f.run('resume', {
      now: () => clock,
      wait: async () => {
        clock += 61_000;
      },
    }),
  ).rejects.toThrow(/healthy/);
});
it('can reconcile the same captured operation after verified rollback health', async () => {
  const f = fixture();
  await f.run('prepare');
  await f.run('rollback');
  expect(f.calls.filter((call) => call.path.endsWith('/resume'))).toHaveLength(1);
});
