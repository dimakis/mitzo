import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import { createWarmPoolAdapter } from './openshell-warm-pool-runtime.js';
import { OpenShellWarmPool } from './openshell-warm-pool.js';
import { setOpenShellWarmPool } from './openshell-warm-pool-binding.js';
/** The lock fences startup recovery: never recover another live controller's
 * reservation. Stale lock evidence is retained, not silently discarded. */
export function startWarmPoolHost(
  config: OpenShellRuntimeConfig | undefined,
  options: { root: string; enrolled: boolean; onError(error: unknown): void },
) {
  if (!config) return undefined;
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const path = join(options.root, 'openshell-warm-pool.lock'),
    nonce = randomUUID();
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const old = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    if (!Number.isInteger(old.pid) || old.pid <= 0)
      throw Error('Warm pool controller owner is unverified');
    try {
      process.kill(old.pid, 0);
      throw Error('Another warm pool controller owns this host');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    renameSync(path, path + '.retained-' + randomUUID());
    fd = openSync(path, 'wx', 0o600);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  closeSync(fd);
  const abort = new AbortController();
  const adapter = createWarmPoolAdapter(config, undefined, undefined, abort.signal);
  if (!options.enrolled) {
    adapter.available = false;
    adapter.reason = 'Warm sandbox preparation is not enabled on this host.';
  }
  let pool: OpenShellWarmPool;
  try {
    pool = new OpenShellWarmPool(join(options.root, 'openshell-warm-pool.db'), adapter);
    pool.recoverInterrupted();
  } catch (e) {
    unlinkSync(path);
    throw e;
  }
  setOpenShellWarmPool(pool);
  const timer = setInterval(() => {
    if (!adapter.available || abort.signal.aborted) return;
    void pool
      .reconcile(AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]))
      .catch(options.onError);
  }, 5000);
  timer.unref();
  let closed = false;
  return {
    pool,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      abort.abort();
      const deadline = Date.now() + 120000;
      while (pool.snapshot().busy && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (pool.snapshot().busy)
        throw Error('Warm pool shutdown outcome is uncertain; ownership record retained');
      setOpenShellWarmPool(null);
      pool.close();
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { nonce: string };
      if (owner.nonce === nonce) unlinkSync(path);
    },
  };
}
