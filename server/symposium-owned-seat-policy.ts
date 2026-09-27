import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { createVertexSeatPolicy } from '../infra/openshell/providers/vertex-seat-policy.mjs';
import type { AccountProfiles } from './account-profiles.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type {
  SymposiumDispatchFacts,
  SymposiumHostGrantVerifier,
} from './symposium-seat-runtime.js';
import { captureSymposiumWorkVertexProvider } from './symposium-work-vertex-provider.js';

export interface SymposiumSeatPolicy {
  readonly path: string;
  readonly sha256: string;
  verify(): void;
  verifyInstalled(sandbox: { sandboxName: string; sandboxId: string }, wait?: boolean): void;
}
export type SymposiumSeatPolicySelector = (request: {
  sessionId: string;
  seatId: string;
  generation: number;
}) => SymposiumSeatPolicy | undefined;
type PolicyInvoke = (args: readonly string[]) => string;
// Pinned OpenShell serializer omits these explicit false endpoint defaults. No
// unknown keys, added routes, protocol aliases, or provider rules are discarded.
function canonicalPolicy(value: unknown): string {
  const object = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  const normalized = structuredClone(value);
  if (object(normalized) && object(normalized.network_policies)) {
    for (const rule of Object.values(normalized.network_policies)) {
      if (!object(rule) || !Array.isArray(rule.endpoints)) continue;
      for (const endpoint of rule.endpoints) {
        if (!object(endpoint)) continue;
        for (const key of ['request_body_credential_rewrite', 'allow_uninspected_credentials']) {
          if (endpoint[key] === false) delete endpoint[key];
        }
      }
    }
  }
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (object(input))
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, visit(v)]),
      );
    return input;
  };
  return JSON.stringify(visit(normalized));
}

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function readPolicy(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o022 ||
      stat.size > 1024 * 1024
    )
      throw new Error('Owned seat policy custody changed');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fstatSync(fd);
    if (
      size !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Owned seat policy changed during read');
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
/** Retained owner only. The public request selects a seat, never policy bytes,
 * account routes, or readiness evidence. Base network permissions are not copied. */
export function createOwnedSeatPolicySelector(options: {
  gateway: OwnedSymposiumGateway;
  basePolicy: string;
  baseDigest: string;
  facts: SymposiumDispatchFacts;
  currentProfiles: () => AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  capture?: typeof captureSymposiumWorkVertexProvider;
  invoke?: PolicyInvoke;
}): SymposiumSeatPolicySelector {
  const retained = new Map<string, SymposiumSeatPolicy>();
  let directory: string | undefined;
  const capture = options.capture ?? captureSymposiumWorkVertexProvider;
  return (request) => {
    const collect = () => {
      options.gateway.verifyCustody();
      const config = options.facts.getActiveSymposiumConfig(request.sessionId);
      const seat = config.seats.find((row) => row.id === request.seatId);
      const membership = options.facts.getLatestSymposiumMembership(
        request.sessionId,
        request.seatId,
      );
      if (
        config.version !== 2 ||
        config.state !== 'active' ||
        !seat ||
        membership?.state !== 'active' ||
        membership.generation !== request.generation
      )
        throw new Error('Owned seat policy membership changed');
      options.hostGrants.verifySeat({
        sessionId: request.sessionId,
        seat,
        membershipGeneration: request.generation,
      });
      const binding = seat.accountBinding;
      if (binding?.provider !== 'anthropic-vertex') return undefined;
      const profiles = options.currentProfiles();
      profiles.resume(binding);
      const route = profiles.vertexSandboxRoute(binding);
      const receipt = capture(options.gateway, route.providerId);
      if (
        receipt.accountId !== binding.accountId ||
        receipt.provider !== route.provider ||
        receipt.providerId !== route.providerId ||
        receipt.projectId !== route.projectId ||
        receipt.region !== route.region ||
        receipt.model !== binding.model ||
        receipt.workspace !== options.gateway.workspace
      )
        throw new Error('Owned seat policy provider changed');
      const baseBytes = readPolicy(options.basePolicy);
      if (digest(baseBytes) !== options.baseDigest)
        throw new Error('Owned seat base policy changed');
      const base = load(baseBytes.toString('utf8')) as Record<string, unknown>;
      if (!base || typeof base !== 'object' || !base.filesystem_policy || !base.landlock)
        throw new Error('Owned seat filesystem policy unavailable');
      const policy = {
        ...createVertexSeatPolicy({
          project: route.projectId,
          region: route.region,
          model: binding.model,
          claudeBinary: '/usr/local/bin/claude',
          providerName: route.provider,
        }),
        filesystem_policy: base.filesystem_policy,
        landlock: base.landlock,
      };
      const bytes = `${JSON.stringify(policy, null, 2)}\n`;
      // Authority and account fingerprints are included even if network bytes happen to match.
      const identity = JSON.stringify([
        request,
        binding,
        seat.authorityGrant,
        receipt,
        options.baseDigest,
      ]);
      return { bytes, identity, provider: receipt.provider, providerId: receipt.providerId };
    };
    const initial = collect();
    if (!initial) return undefined;
    const key = digest(initial.identity);
    const previous = retained.get(key);
    if (previous) {
      previous.verify();
      return previous;
    }
    if (!directory) {
      directory = join(options.gateway.stateDirectory, `seat-policies-${randomUUID()}`);
      mkdirSync(directory, { mode: 0o700 });
    }
    const path = join(directory, `${key}.json`);
    writeFileSync(path, initial.bytes, { flag: 'wx', mode: 0o400 });
    const sha256 = digest(initial.bytes);
    const policy: SymposiumSeatPolicy = Object.freeze({
      path,
      sha256,
      verify: () => {
        const current = collect();
        const parent = lstatSync(directory!);
        if (
          !current ||
          current.identity !== initial.identity ||
          current.bytes !== initial.bytes ||
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          parent.uid !== process.getuid?.() ||
          parent.mode & 0o077 ||
          digest(readPolicy(path)) !== sha256
        )
          throw new Error('Owned seat policy changed');
      },
      verifyInstalled: (sandbox: { sandboxName: string; sandboxId: string }, wait = false) => {
        policy.verify();
        if (
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sandbox.sandboxName) ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(sandbox.sandboxId)
        )
          throw new Error('Owned seat sandbox identity unavailable');
        const invoke =
          options.invoke ??
          ((args: readonly string[]) => {
            const result = spawnSync(options.gateway.cli, [...args], {
              env: options.gateway.managementEnvironment,
              encoding: 'utf8',
              timeout: wait ? 8000 : 5000,
              maxBuffer: 1024 * 1024,
            });
            if (result.error || result.status !== 0)
              throw new Error('Owned seat policy inspection unavailable');
            return result.stdout;
          });
        const scope = [
          '--gateway',
          options.gateway.gateway,
          '--workspace',
          options.gateway.workspace,
        ];
        const inspect = () => {
          const row = JSON.parse(
            invoke(['sandbox', ...scope, 'get', sandbox.sandboxName, '--output', 'json']),
          );
          if (
            row.id !== sandbox.sandboxId ||
            row.name !== sandbox.sandboxName ||
            row.workspace !== options.gateway.workspace ||
            row.phase !== 'Ready' ||
            row.labels?.['mitzo.account_provider'] !== initial.provider
          )
            throw new Error('Owned seat sandbox identity changed');
        };
        inspect();
        const rawPolicy = invoke([
          'policy',
          ...scope,
          'get',
          sandbox.sandboxName,
          '--full',
          '--output',
          'json',
        ]);
        const observed = JSON.parse(rawPolicy);
        // Pinned Rust output renders this SHA-derived u64 as a decimal JSON number.
        // Retain the token losslessly rather than trusting JSON.parse's rounded Number.
        const revisions = [...rawPolicy.matchAll(/"config_revision"\s*:\s*([0-9]+)(?=\s*[,}])/g)];
        const revision = revisions.length === 1 ? revisions[0][1] : '';
        const u64 = (value: unknown): value is string =>
          typeof value === 'string' &&
          /^(?:0|[1-9][0-9]{0,19})$/.test(value) &&
          BigInt(value) <= 18446744073709551615n;
        if (!u64(revision)) throw new Error('Owned seat config revision unavailable');
        if (
          observed.scope !== 'sandbox' ||
          observed.sandbox !== sandbox.sandboxName ||
          observed.status !== 'effective' ||
          observed.policy_source !== 'sandbox' ||
          !Number.isSafeInteger(observed.version) ||
          observed.version < 1 ||
          observed.active_version !== observed.version ||
          !/^(?:sha256:)?[a-f0-9]{64}$/.test(observed.hash) ||
          canonicalPolicy(observed.policy) !== canonicalPolicy(JSON.parse(initial.bytes))
        )
          throw new Error('Owned seat effective policy changed');
        const installed = JSON.parse(
          invoke([
            'sandbox',
            ...scope,
            'provider',
            'status',
            sandbox.sandboxName,
            initial.provider,
            '--output',
            'json',
            ...(wait ? ['--wait', '--timeout', '5'] : []),
          ]),
        );
        const target =
          Array.isArray(installed.targets) && installed.targets.length === 1
            ? installed.targets[0]
            : undefined;
        const desired = target?.receipt?.desired,
          actual = target?.observed;
        if (
          !target ||
          target.state !== 'ready' ||
          target.reason !== 'unspecified' ||
          typeof target.network_instance_id !== 'string' ||
          !target.network_instance_id ||
          target.receipt.provider !== initial.provider ||
          target.receipt.workspace !== options.gateway.workspace ||
          !desired ||
          desired.sandbox !== sandbox.sandboxName ||
          desired.sandbox_id !== sandbox.sandboxId ||
          desired.provider_id !== initial.providerId ||
          desired.policy_hash !== observed.hash ||
          desired.config_revision !== revision ||
          !u64(desired.provider_env_revision) ||
          typeof desired.attachment_epoch !== 'string' ||
          !actual ||
          typeof actual.session_id !== 'string' ||
          !actual.session_id ||
          typeof actual.process_instance_id !== 'string' ||
          !actual.process_instance_id ||
          actual.reason !== 'unspecified' ||
          actual.credentials_installed !== true ||
          actual.policy_active !== true ||
          actual.launch_environment_installed !== true ||
          actual.attachment_epoch !== desired.attachment_epoch ||
          actual.provider_env_revision !== desired.provider_env_revision ||
          actual.config_revision !== desired.config_revision ||
          actual.policy_hash !== desired.policy_hash
        )
          throw new Error('Owned seat supervisor installation unavailable');
        inspect();
        policy.verify();
      },
    });
    // Retain our exact exclusive-create identity even if a fresh post-write
    // authority/readiness check fails. A later call must verify these same bytes;
    // it never adopts an unknown file, overwrites it, or skips current authority.
    retained.set(key, policy);
    policy.verify();
    return policy;
  };
}
