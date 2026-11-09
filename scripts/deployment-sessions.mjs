#!/usr/bin/env node
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';
import console from 'node:console';
import { readFile, writeFile, lstat, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Production transport is explicit and local. Never forward an operator token
 * to redirects, a browser-selected host, or the historical staging endpoint. */
export function deploymentBase(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '3101' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('Deployment API must be http://127.0.0.1:3101');
  return url.origin;
}
export async function reconcileDeployment({
  action,
  targetCommit,
  statePath,
  tokenPath,
  sessionId,
  base = 'http://127.0.0.1:3101',
  fetcher = globalThis.fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const origin = deploymentBase(base);
  if (
    ![
      'prepare',
      'activate',
      'health',
      'resume',
      'rollback',
      'reauthorize',
      'reconcile',
      'cancel',
    ].includes(action)
  )
    throw Error('Unsupported deployment action');
  if (!statePath || !tokenPath)
    throw Error('Deployment state and signed operator token files are required');
  const tokenInfo = await lstat(tokenPath);
  if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || tokenInfo.mode & 0o077)
    throw Error('Operator token must be a private regular file');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token || /\s/.test(token)) throw Error('Invalid operator token file');
  async function request(path, body) {
    const response = await fetcher(origin + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(130_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? 'Deployment API unavailable; hold retained');
    return value;
  }
  async function save(value) {
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const next = `${statePath}.${randomUUID()}.next`;
    await writeFile(next, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(next, statePath);
  }
  let state;
  try {
    const info = await lstat(statePath);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw Error('Deployment state must be a private regular file');
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (action === 'prepare') {
    if (!/^[a-f0-9]{40}$/.test(targetCommit ?? '')) throw Error('Exact target commit required');
    if (state && state.targetCommit !== targetCommit) throw Error('Deployment target changed');
    // Check protocol before creating an operation. Older daemons require the
    // documented first-install idle procedure, never an unsafe pause fallback.
    const capability = await request('/api/deployment');
    if (capability.protocol !== 1)
      throw Error('Deployment protocol unavailable; first installation requires idle guard');
    const version = await request('/api/version');
    if (!state) {
      state = { id: randomUUID(), targetCommit, sourceCommit: version.commit };
      await save(state);
    }
    await request('/api/deployment/begin', { id: state.id, targetCommit });
    const deadline = now() + 120_000;
    while (true) {
      const result = await request('/api/deployment/pause', { id: state.id });
      if (result.operation.phase === 'paused') {
        await save({ ...state, phase: 'paused' });
        return result.operation;
      }
      if (
        result.operation.sessions.some((session) =>
          ['blocked', 'uncertain'].includes(session.state),
        ) ||
        now() >= deadline
      )
        throw Error(
          `Deployment pause remains blocked; retain operation ${state.id} and inspect /api/deployment`,
        );
      await wait(1000);
    }
  }
  if (
    !state?.id ||
    !/^[a-f0-9]{40}$/.test(state.targetCommit ?? '') ||
    !/^[a-f0-9]{40}$/.test(state.sourceCommit ?? '')
  )
    throw Error('Retained deployment state required');
  if (action === 'activate') {
    if (!state.activationId) {
      state.activationId = randomUUID();
      await save(state);
    }
    return (
      await request('/api/deployment/activate', { id: state.id, activationId: state.activationId })
    ).operation;
  }
  if (action === 'reauthorize' || action === 'reconcile') {
    if (!state.activationId) throw Error('Retained private activation capability required');
    if (action === 'reconcile' && (typeof sessionId !== 'string' || !/^\S{1,200}$/.test(sessionId)))
      throw Error('Captured blocked session ID required');
    return (
      await request(`/api/deployment/${action}`, {
        id: state.id,
        activationId: state.activationId,
        ...(action === 'reconcile' ? { sessionId } : {}),
      })
    ).operation;
  }
  if (action === 'cancel')
    return (await request('/api/deployment/cancel', { id: state.id })).operation;
  const expected = action === 'rollback' ? state.sourceCommit : state.targetCommit;
  const deadline = now() + 60_000;
  while (true) {
    let ready = false;
    try {
      const version = await request('/api/version'),
        health = await request('/api/service-health');
      ready =
        version.commit === expected &&
        health.checkedAt > now() - 60_000 &&
        health.services?.length === 2 &&
        health.services.every((service) => service.ok) &&
        new Set(health.services.map((service) => service.name)).size === 2 &&
        health.services.every((service) => ['yapper', 'contexgin'].includes(service.name));
    } catch {
      /* Daemon startup may still be in progress. */
    }
    if (ready) break;
    if (now() >= deadline)
      throw Error('Expected release did not become healthy; deployment hold retained');
    await wait(1000);
  }
  if (action === 'health') {
    const result = await request('/api/deployment');
    if (result.active?.id !== state.id) throw Error('Original deployment hold required');
    return result.active;
  }
  const result = await request('/api/deployment/resume', {
    id: state.id,
    ...(state.activationId ? { activationId: state.activationId } : {}),
    ...(action === 'rollback' ? { rollback: true } : {}),
  });
  await save({ ...state, phase: result.operation.phase });
  if (result.operation.phase !== 'completed')
    throw Error(
      `Continuation remains blocked or uncertain; inspect operation ${state.id}. Do not replay or roll back running resumed work.`,
    );
  return result.operation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, targetCommit] = process.argv.slice(2);
  try {
    const operation = await reconcileDeployment({
      action,
      targetCommit,
      sessionId: action === 'reconcile' ? targetCommit : undefined,
      statePath: process.env.MITZO_DEPLOY_STATE_PATH,
      tokenPath: process.env.MITZO_DEPLOY_OPERATOR_TOKEN_FILE,
    });
    console.log(
      JSON.stringify({
        id: operation.id,
        phase: operation.phase,
        sessions: operation.sessions.map(({ sessionId, state, error }) => ({
          sessionId,
          state,
          error,
        })),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
