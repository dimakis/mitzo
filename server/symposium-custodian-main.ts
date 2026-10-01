import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BootstrapTools } from './symposium-owned-config.js';
import type { OwnedSymposiumHostOptions } from './symposium-owned-host.js';
import { custodianAppEnvironment } from './symposium-custodian-launch.js';
import { SymposiumCustodianController } from './symposium-custodian-controller.js';
import { serveCustodianController, type CustodianChannel } from './symposium-custodian-ipc.js';
import { dispatchCustodianHttp } from './symposium-custodian-http.js';
import {
  finishCustodianRetirement,
  writeCustodianRetirementReceipt,
} from './symposium-custodian-retirement.js';

/** Explicit fresh-owner entry point. No attach/reconstruct command exists. */
export interface SymposiumCustodianConstructorHooks {
  bootstrapTools?: BootstrapTools;
  observeDurableReviewToolResult?: OwnedSymposiumHostOptions['observeDurableReviewToolResult'];
}
export async function runSymposiumCustodian(hooks: SymposiumCustodianConstructorHooks = {}) {
  const { bootstrapTools, observeDurableReviewToolResult } = hooks;
  if (
    observeDurableReviewToolResult !== undefined &&
    typeof observeDurableReviewToolResult !== 'function'
  )
    throw Error('Custodian observer must be a trusted constructor callback');
  if (process.env.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER || process.send)
    throw Error('Custodian must be launched as the independent owner');
  const filename = process.env.MITZO_SYMPOSIUM_OWNED_HOST_CONFIG;
  if (!filename) throw Error('A fresh owned Symposium configuration is required');
  process.env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER = '1';
  // Mode is established before importing any store, recovery or app module.
  const engine = await import('./app.js');
  const { bootstrapConfiguredSymposiumHost } = await import('./symposium-owned-config.js');
  const { revokeAuthSession, registerAuthSession } = await import('./auth.js');
  const host = await bootstrapConfiguredSymposiumHost(
    filename,
    {
      ...engine.getSymposiumBootstrapDependencies(),
      observeDurableReviewToolResult,
    },
    bootstrapTools,
  );
  engine.installSymposiumProductionHost(host);
  const identity = randomUUID();
  let controllerGeneration = 0;
  let child: ChildProcess | undefined;
  let stopping = false;
  const controller = new SymposiumCustodianController({
    pause() {
      engine.pauseSymposiumController();
      host.pauseController();
    },
    async drain(signal) {
      const results = await Promise.allSettled([
        engine.drainSymposiumController(`${identity}-${controllerGeneration}`, signal),
        host.quiesceController(signal),
      ]);
      signal.throwIfAborted();
      if (results.some((result) => result.status === 'rejected'))
        throw Error('Retained controller cleanup requires recovery');
    },
    resume() {
      engine.resumeSymposiumController();
      host.resumeController();
      controllerGeneration++;
    },
    invalidate(id) {
      revokeAuthSession({ id, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    },
    async dispatch(command, assertCurrent, approval, signal) {
      let invalidated = false;
      const unregister = registerAuthSession(command.authorization, () => {
        invalidated = true;
      });
      const authorize = () => {
        assertCurrent();
        if (invalidated) throw Error('Operator authorization expired or revoked');
      };
      try {
        authorize();
        if (command.operation === 'custody.status') {
          host.currentProfiles(); // Recheck the original gateway owner, never discover/adopt a PID.
          if (!child?.pid || !child.connected) throw Error('Controller child unavailable');
          return {
            status: 200,
            body: {
              instanceId: identity,
              epoch: command.epoch,
              custodianPid: process.pid,
              controllerPid: child.pid,
              state: 'active',
              scope: 'fresh-retained-sessions',
            },
          };
        }
        if (command.sessionId && !engine.hasRetainedCustodianSession(command.sessionId))
          throw Error('This session is not held by the current custodian');
        const result = await dispatchCustodianHttp(
          engine.app,
          command,
          authorize,
          approval,
          signal,
        );
        if (command.operation === 'session.create' && result.status < 300) {
          const sessionId = (result.body as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sessionId !== 'string' || !engine.hasRetainedCustodianSession(sessionId))
            throw Error('Historical session allocation cannot transfer custodian authority');
        }
        authorize();
        return result;
      } finally {
        unregister();
      }
    },
  });
  engine.setSymposiumCustodianBroadcast((sessionId, event) => {
    if (!child?.connected || stopping) return;
    const frame = { kind: 'event', sessionId, event };
    if (Buffer.byteLength(JSON.stringify(frame)) > 1_048_576) return; // Durable replay remains authoritative.
    child.send(frame, () => {});
  });
  const stop = () => {
    stopping = true;
    if (child?.connected) child.disconnect();
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopping) {
      child = fork(new URL('./index.js', import.meta.url), [], {
        env: custodianAppEnvironment(process.env),
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const exactChild = child;
      const exited = new Promise<void>((resolve) => exactChild.once('exit', () => resolve()));
      try {
        await serveCustodianController(exactChild as unknown as CustodianChannel, controller);
      } catch {
        stopping = true;
        throw Error('Controller lost; retained resources remain quarantined');
      } finally {
        if (exactChild.exitCode === null && exactChild.signalCode === null) {
          exactChild.kill('SIGTERM');
          const timer = setTimeout(() => exactChild.kill('SIGKILL'), 5000);
          await exited;
          clearTimeout(timer);
        }
        child = undefined;
      }
      // Never auto-retry an app startup failure in a tight loop.
      if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    const signal = AbortSignal.timeout(120_000);
    await finishCustodianRetirement(
      {
        begin() {
          engine.beginSymposiumShutdown();
          host.beginShutdown();
        },
        retireRuntimes: (signal) =>
          engine.retireRetainedSymposiumRuntimes(
            `${identity}-${controllerGeneration}-retirement`,
            signal,
          ),
        drainHost: (signal) => host.drain(signal),
        closeHost: (signal) => host.closeAfterDrain(signal),
        record: () =>
          writeCustodianRetirementReceipt({
            stateParent: dirname(host.gateway.stateDirectory),
            gatewayStateDirectory: host.gateway.stateDirectory,
            instanceId: identity,
            controllerGeneration,
          }),
      },
      signal,
    );
  } catch {
    try {
      host.markShutdownUncertain();
    } catch {
      // A terminal-receipt write can fail after custody stores have closed.
      // Failure remains visible without resurrecting any original capability.
    }
    // Keep original owners/ledgers alive for diagnosis. Never reconstruct their
    // capabilities in a replacement process or claim successful cleanup.
    process.stderr.write(
      'Symposium custodian fenced: cleanup is unconfirmed; resources remain quarantined.\n',
    );
    process.exitCode = 1;
  }
}
/** Importing this module cannot bootstrap a host or load app authentication. */
export function isDirectSymposiumCustodianEntry(argvPath: string | undefined): boolean {
  return !!argvPath && resolve(argvPath) === fileURLToPath(import.meta.url);
}
if (isDirectSymposiumCustodianEntry(process.argv[1]))
  void import('dotenv/config')
    .then(() => runSymposiumCustodian())
    .catch(() => {
      process.stderr.write(
        'Symposium custodian startup failed; no existing resources were adopted.\n',
      );
      process.exitCode = 1;
    });
