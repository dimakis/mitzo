import { openShellCliEnvironment } from './openshell-cli-environment.js';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { preparePublishedOpenShellSeed, type OpenShellRuntimeConfig } from './openshell-runtime.js';
import { parseProviderAttachments } from './connections-gateway.js';
import {
  hasWarmPoolRuntimeAuthority,
  type WarmPoolAdapter,
  type WarmPoolRecord,
  type WarmSandbox,
} from './openshell-warm-pool.js';
export function warmPoolScope(c: OpenShellRuntimeConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        c.cli,
        c.cliContract ?? null,
        c.gateway,
        c.workspace,
        c.gatewayEndpoint ?? null,
        c.gatewayInsecure,
        c.image,
        createHash('sha256').update(readFileSync(c.policy)).digest('hex'),
        c.workdir,
        c.seed,
        c.seedStackManifest ?? null,
        openShellCliEnvironment(c.cliEnvironment),
      ]),
    )
    .digest('hex');
}
/** Access authority is stable across image/policy/seed contract updates. This
 * permits verified observation for migration/retirement, never recipe adoption. */
export function warmPoolRuntimeAuthority(c: OpenShellRuntimeConfig) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'warm-pool-runtime-authority-v1',
        c.cli,
        c.cliContract ?? null,
        c.gateway,
        c.workspace,
        c.gatewayEndpoint ?? null,
        c.gatewayInsecure,
        c.workdir,
        openShellCliEnvironment(c.cliEnvironment),
      ]),
    )
    .digest('hex');
}
type Run = (args: readonly string[], signal: AbortSignal) => Promise<string>;
const Physical = z.object({
  id: z.string().min(1),
  name: z.string(),
  workspace: z.string(),
  phase: z.string(),
  labels: z.record(z.string(), z.string()),
});
/** Pinned legacy CLI adapter: resource flags are CPU/memory only. No credentials
 * are discovered or created, and no native model process is started here. */
export function createWarmPoolAdapter(
  config: OpenShellRuntimeConfig,
  runner?: Run,
  prepareSeed = preparePublishedOpenShellSeed,
  hostSignal?: AbortSignal,
): WarmPoolAdapter {
  const scope = warmPoolScope(config);
  const runtimeAuthority = warmPoolRuntimeAuthority(config);
  const execute: Run =
    runner ??
    ((args, signal) =>
      new Promise((resolve, reject) =>
        execFile(
          config.cli,
          [...args],
          {
            signal,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
            env: openShellCliEnvironment(config.cliEnvironment),
          },
          (e, stdout) => (e ? reject(e) : resolve(stdout)),
        ),
      ));
  const run: Run = (args, signal) =>
    execute(args, hostSignal ? AbortSignal.any([hostSignal, signal]) : signal);
  const base = [
    'sandbox',
    ...(config.gatewayEndpoint
      ? [
          '--gateway-endpoint',
          config.gatewayEndpoint,
          ...(config.gatewayInsecure ? ['--gateway-insecure'] : []),
        ]
      : ['--gateway', config.gateway]),
    '--workspace',
    config.workspace,
  ];
  const assertCurrent = () => {
    if (warmPoolScope(config) !== scope) throw Error('Warm pool runtime configuration changed');
  };
  const assertAccess = (record: WarmPoolRecord) => {
    if (
      warmPoolRuntimeAuthority(config) !== runtimeAuthority ||
      !hasWarmPoolRuntimeAuthority(record, { scope, runtimeAuthority })
    )
      throw Error('Warm sandbox runtime authority differs');
  };
  const inspect = async (
    record: WarmPoolRecord,
    signal: AbortSignal,
  ): Promise<WarmSandbox | undefined> => {
    assertAccess(record);
    // Both reads describe the same immutable physical target. Settle both so
    // an absent sandbox keeps its authoritative absence result and a peer
    // rejection is always observed.
    const [physical, attachments] = await Promise.allSettled([
      run([...base, 'get', record.name, '--output', 'json'], signal),
      run([...base, 'provider', 'list', record.name], signal),
    ]);
    if (physical.status === 'rejected') {
      const e: unknown = physical.reason;
      if (/not found|404|does not exist/i.test(e instanceof Error ? e.message : ''))
        return undefined;
      throw e;
    }
    const s = Physical.parse(JSON.parse(physical.value));
    if (
      s.name !== record.name ||
      s.workspace !== config.workspace ||
      s.labels['mitzo.warm_pool'] !== record.id ||
      s.labels['mitzo.conversation'] ||
      s.labels['mitzo.account_provider'] ||
      (record.physicalId && record.physicalId !== s.id) ||
      !hasWarmPoolRuntimeAuthority(record, { scope, runtimeAuthority })
    )
      throw Error('Warm sandbox physical identity differs');
    if (attachments.status === 'rejected') throw attachments.reason;
    const providers = parseProviderAttachments(attachments.value, record.name);
    return { id: s.id, name: s.name, phase: s.phase, poolId: record.id, providers };
  };
  const adapter: WarmPoolAdapter = {
    scope,
    runtimeAuthority,
    connectionAuthority: {
      gateway: config.gatewayEndpoint
        ? 'endpoint:' + createHash('sha256').update(config.gatewayEndpoint).digest('hex')
        : config.gateway,
      workspace: config.workspace,
    },
    available: !config.cliContract && !config.artifactDriverConfig && !config.sandboxNameOverride,
    reason:
      config.cliContract || config.artifactDriverConfig || config.sandboxNameOverride
        ? 'Warm pooling requires the ordinary OpenShell CLI runtime. Native seat and shared overrides are not supported.'
        : null,
    inspect,
    async prepare(record, signal, created, dispatched) {
      assertCurrent();
      if (record.scope !== scope || !hasWarmPoolRuntimeAuthority(record, adapter))
        throw Error('Warm sandbox preparation recipe differs');
      if (!adapter.available) throw Error(adapter.reason!);
      // Neutral warming needs no task knowledge. Claim selects and verifies
      // fresh knowledge; an unused warm-up copy only duplicates that work.
      signal.throwIfAborted();
      dispatched?.();
      const output = Physical.parse(
        JSON.parse(
          await run(
            [
              ...base,
              'create',
              '--name',
              record.name,
              '--from',
              config.image,
              '--policy',
              config.policy,
              '--cpu',
              String(record.resources.cpu),
              '--memory',
              record.resources.memoryGiB + 'Gi',
              '--label',
              'mitzo.warm_pool=' + record.id,
              '--no-auto-providers',
              '--detach',
              '--output',
              'json',
            ],
            signal,
          ),
        ),
      );
      if (
        output.name !== record.name ||
        output.workspace !== config.workspace ||
        output.labels['mitzo.warm_pool'] !== record.id ||
        output.labels['mitzo.conversation'] ||
        output.labels['mitzo.account_provider']
      )
        throw Error('Warm sandbox create identity differs');
      created?.(output.id);
      let observed = await inspect({ ...record, physicalId: output.id }, signal);
      const deadline = Date.now() + 90000;
      while (
        observed &&
        ['Pending', 'Creating', 'Starting'].includes(observed.phase) &&
        Date.now() < deadline
      ) {
        await delay(250, undefined, { signal });
        observed = await inspect({ ...record, physicalId: output.id }, signal);
      }
      if (!observed || observed.phase !== 'Ready')
        throw Error('Warm sandbox readiness is unverified');
      return observed;
    },
    async remove(record, signal) {
      const before = await inspect(record, signal);
      if (
        !before ||
        before.id !== record.physicalId ||
        before.providers.length ||
        record.conversationId
      )
        throw Error('Unclaimed sandbox removal identity differs');
      await run([...base, 'delete', record.name], signal);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const remaining = await inspect(record, signal);
        if (!remaining) return;
        if (remaining.id !== record.physicalId || remaining.providers.length)
          throw Error('Sandbox identity changed during removal');
        await delay(250, undefined, { signal });
      }
      throw Error('Sandbox removal outcome is not confirmed');
    },
    async bind(record, provider, signal, seed, services = [], recovering = false) {
      assertCurrent();
      if (record.scope !== scope || !hasWarmPoolRuntimeAuthority(record, adapter))
        throw Error('Warm sandbox claim recipe differs');
      if (
        record.state !== 'claiming' ||
        !record.conversationId ||
        record.provider !== provider ||
        !record.physicalId
      )
        throw Error('Durable claim required before account attachment');
      const desired = [...new Set([provider, ...services])];
      const allowed = (names: string[]) =>
        recovering ? names.every((x) => desired.includes(x)) : names.length === 0;
      const initial = await inspect(record, signal);
      if (!initial || !allowed(initial.providers) || initial.phase !== 'Ready')
        throw Error('Claim requires a provider-free Ready sandbox');
      const prepared = seed ? { seed, cleanup: () => {} } : await prepareSeed(config, signal);
      try {
        assertCurrent();
        signal.throwIfAborted();
        await run([...base, 'upload', record.name, prepared.seed, '/sandbox/workspaces'], signal);
        const before = await inspect(record, signal);
        if (!before || before.id !== record.physicalId || !allowed(before.providers))
          throw Error('Claim upload identity changed');
        assertCurrent();
        for (const name of desired.filter((x) => !before.providers.includes(x)))
          await run([...base, 'provider', 'attach', record.name, name], signal);
        const after = await inspect(record, signal);
        if (
          !after ||
          after.providers.length !== desired.length ||
          desired.some((x) => !after.providers.includes(x))
        )
          throw Error('Claim provider attachment set differs');
        assertCurrent();
        return after;
      } finally {
        prepared.cleanup();
      }
    },
  };
  return adapter;
}
