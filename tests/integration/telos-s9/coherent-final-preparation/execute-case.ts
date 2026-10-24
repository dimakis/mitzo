import { expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, relative, isAbsolute } from 'node:path';
import type { ColdHandoff } from './cold-handoff.js';
import { coldReadback } from './cold-readback.js';

/** Exactly one executing App carrier at a time. The outer Vitest worker is an
 * idle driver while the child owns App/provider fake callbacks. The carrier
 * closes its resources, exits, and is reaped before the cold App starts. */
export async function executeCoherentCase(kind: 'repository' | 'non-git') {
  const controlRoot = await realpath(await mkdtemp(join(tmpdir(), 's9-coherent-driver-'))),
    handoffPath = join(controlRoot, 'handoff.json');
  const records: Array<{ stage: string; facts: Record<string, unknown> }> = [];
  const record = async (stage: string, facts: Record<string, unknown>) => {
    records.push({ stage, facts });
    if (process.env.S9_COHERENT_EVIDENCE_DIR)
      await writeFile(
        join(process.env.S9_COHERENT_EVIDENCE_DIR, kind + '-cold.json'),
        JSON.stringify(records, null, 2),
      );
  };
  const cleanupErrors: unknown[] = [];
  let data: ColdHandoff | undefined,
    child: ReturnType<typeof spawn> | undefined,
    originalError: unknown;
  try {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      NODE_OPTIONS: '--max-old-space-size=1024',
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: controlRoot,
      S9_COHERENT_KIND: kind,
      S9_COHERENT_HANDOFF: handoffPath,
      S9_COHERENT_PID_PATH: join(controlRoot, 'initial-app-pid.json'),
    };
    for (const key of [
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'S9_MGMT_PYTHON',
      'S9_MGMT_SOURCE_ROOT',
      'S9_CODEX_NATIVE_FIXTURE',
      'S9_COHERENT_EVIDENCE_DIR',
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    child = spawn(
      process.execPath,
      [
        resolve('node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'tests/integration/telos-s9/coherent-final-preparation/vitest.initial.config.ts',
      ],
      { cwd: resolve('.'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let diagnostic = '';
    for (const stream of [child.stdout, child.stderr])
      stream!.on('data', (bytes) => {
        diagnostic = (diagnostic + String(bytes)).slice(-131072);
      });
    const ended = once(child, 'close');
    const timer = setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null)
        process.kill(-child.pid, 'SIGKILL');
    }, 75_000);
    let outcome: unknown[];
    try {
      outcome = await ended;
    } finally {
      clearTimeout(timer);
    }
    await record('initial-single-app-carrier-os-process-reaped', {
      pid: child.pid,
      outcome,
      diagnostic,
    });
    expect(outcome).toEqual([0, null]);
    data = JSON.parse(await readFile(handoffPath, 'utf8')) as ColdHandoff;
    expect(data.application.kind).toBe(kind);
    const rel = relative(await realpath(tmpdir()), await realpath(data.application.root));
    if (
      !basename(data.application.root).startsWith('s9-coherent-') ||
      rel.startsWith('..') ||
      isAbsolute(rel)
    )
      throw Error('Only the retained real private App root may transfer cleanup');
    let workerPresent = false;
    try {
      process.kill(data.initialAppPid, 0);
      workerPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    expect(workerPresent, 'Initial App worker must be reaped before cold owner construction').toBe(
      false,
    );
    await record('initial-app-worker-pid-independently-absent-before-cold', {
      pid: data.initialAppPid,
    });
    await coldReadback(data, record);
  } catch (error) {
    originalError = error;
  } finally {
    const errors = cleanupErrors;
    let transferredRoot = data?.application.root;
    if (child && child.exitCode === null && child.signalCode === null) {
      const reaped = once(child, 'close');
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      try {
        await reaped;
      } catch (error) {
        errors.push(error);
      }
    }
    // On an initial oracle/teardown failure, still recover an already transferred
    // synthetic root and remove it only after the initial process was reaped.
    if (!data) {
      try {
        data = JSON.parse(await readFile(handoffPath, 'utf8')) as ColdHandoff;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
      }
    }
    transferredRoot ??= data?.application.root;
    let retainedWorkerPresent = false;
    try {
      const marker = JSON.parse(
        await readFile(join(controlRoot, 'initial-app-pid.json'), 'utf8'),
      ) as { pid: number; root: string };
      transferredRoot ??= marker.root;
      try {
        process.kill(marker.pid, 0);
        retainedWorkerPresent = true;
        errors.push(Error('Initial private worker still exists; transferred root preserved'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
    }
    if (transferredRoot && !retainedWorkerPresent) {
      try {
        const root = await realpath(transferredRoot);
        const rel = relative(await realpath(tmpdir()), root);
        if (!basename(root).startsWith('s9-coherent-') || rel.startsWith('..') || isAbsolute(rel))
          errors.push(Error('Invalid transferred private root'));
        else await rm(root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (!retainedWorkerPresent) await rm(controlRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(originalError ? [originalError] : []), ...cleanupErrors],
      'Acceptance driver and awaited cleanup failed',
      { cause: originalError ?? cleanupErrors[0] },
    );
  if (originalError) throw originalError;
}
