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
        c.cliEnvironment ?? null,
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
        c.cliEnvironment ?? null,
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
            env: config.cliEnvironment ? { ...process.env, ...config.cliEnvironment } : process.env,
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
    let raw: unknown;
    try {
      raw = JSON.parse(await run([...base, 'get', record.name, '--output', 'json'], signal));
    } catch (e) {
      if (/not found|404|does not exist/i.test(e instanceof Error ? e.message : ''))
        return undefined;
      throw e;
    }
    const s = Physical.parse(raw);
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
    const providers = parseProviderAttachments(
      await run([...base, 'provider', 'list', record.name], signal),
      record.name,
    );
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
      const prepared = await prepareSeed(config, signal);
      try {
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
                '--upload',
                prepared.seed + ':/sandbox/pool-knowledge',
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
      } finally {
        prepared.cleanup();
      }
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
    async bind(record, provider, signal, seed, services = []) {
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
      const initial = await inspect(record, signal);
      if (!initial || initial.providers.length || initial.phase !== 'Ready')
        throw Error('Claim requires a provider-free Ready sandbox');
      const prepared = seed ? { seed, cleanup: () => {} } : await prepareSeed(config, signal);
      try {
        await run([...base, 'upload', record.name, prepared.seed, '/sandbox/workspaces'], signal);
        const before = await inspect(record, signal);
        if (!before || before.id !== record.physicalId || before.providers.length)
          throw Error('Claim upload identity changed');
        const desired = [...new Set([provider, ...services])];
        for (const name of desired)
          await run([...base, 'provider', 'attach', record.name, name], signal);
        const after = await inspect(record, signal);
        if (
          !after ||
          after.providers.length !== desired.length ||
          desired.some((x) => !after.providers.includes(x))
        )
          throw Error('Claim provider attachment set differs');
      } finally {
        prepared.cleanup();
      }
    },
  };
  return adapter;
}
