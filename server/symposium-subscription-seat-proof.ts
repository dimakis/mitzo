import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@mitzo/protocol/event-store';
import type { AccountProfiles } from './account-profiles.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import { sandboxNameForConversation } from './openshell-runtime.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import {
  admitSymposiumSeatDispatch,
  type SymposiumDispatchFacts,
  type SymposiumHostGrantVerifier,
} from './symposium-seat-runtime.js';
import {
  createOpenShellProviderIdentityResolver,
  snapshotSymposiumSeatProvider,
} from './symposium-session-runtime.js';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';

type Input = Parameters<VerifySymposiumSubscriptionAuth>[0];
export interface SymposiumSubscriptionSeatProofOptions {
  facts: SymposiumDispatchFacts;
  currentProfiles(): AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  registry: Pick<EventStore, 'getSymposiumSeatSandbox'>;
  runtimeConfig: OpenShellRuntimeConfig;
  /** Required live host custody, not a caller-supplied admission boolean. */
  verifyGatewayCustody(): void;
}
const Sandbox = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
  phase: z.literal('Ready'),
  labels: z.record(z.string(), z.string()),
});
const Attachments = z.object({
  providers: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })),
  next_page_token: z.string(),
});

/** Composes durable delivery/membership/grant truth with authenticated public
 * gateway identity and attachment reads. The separate subscription receipt
 * verifies OAuth ownership; neither proof substitutes for the other. */
export function createSymposiumSubscriptionSeatProof(
  options: SymposiumSubscriptionSeatProofOptions,
  runProcess: typeof spawnSync = spawnSync,
) {
  const config = options.runtimeConfig;
  if (
    config.cliContract !== 'v0.1' ||
    config.gatewayInsecure ||
    !config.cliEnvironment ||
    config.workdir !== '/sandbox/workspaces/mgmt'
  )
    throw new Error('Subscription seat proof requires the owned verified-TLS native runtime');
  const environment = validateOpenShellCliEnvironment(config.cliEnvironment);
  const base = [
    ...(config.gatewayEndpoint
      ? ['--gateway-endpoint', config.gatewayEndpoint]
      : ['--gateway', config.gateway]),
    '--workspace',
    config.workspace,
  ];
  const invoke = (args: readonly string[]) => {
    options.verifyGatewayCustody();
    const result = runProcess(config.cli, [...args], {
      env: environment,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    options.verifyGatewayCustody();
    if (result.error || result.status !== 0)
      throw new Error('Subscription public gateway proof is unavailable');
    return String(result.stdout);
  };
  const resolve = createOpenShellProviderIdentityResolver(config, invoke);
  const assertCurrent = (input: Input): void => {
    options.verifyGatewayCustody();
    input.execution.signal.throwIfAborted();
    const { sandbox, execution } = input;
    if (
      sandbox.cli !== config.cli ||
      sandbox.gateway !== config.gateway ||
      sandbox.workspace !== config.workspace ||
      sandbox.gatewayEndpoint !== config.gatewayEndpoint ||
      sandbox.gatewayInsecure !== false ||
      sandbox.workdir !== config.workdir ||
      JSON.stringify(sandbox.cliEnvironment) !== JSON.stringify(config.cliEnvironment)
    )
      throw new Error('Subscription sandbox gateway route changed');
    const current = admitSymposiumSeatDispatch(
      options.facts,
      options.currentProfiles(),
      execution,
      options.hostGrants,
    );
    if (
      current.kind !== 'chatgpt-subscription-native' ||
      JSON.stringify(current) !== JSON.stringify(input.route)
    )
      throw new Error('Subscription account profile or route changed');
    const snapshot = snapshotSymposiumSeatProvider(
      execution.sessionId,
      execution.seat.id,
      options.facts,
      options.currentProfiles,
      options.hostGrants,
      resolve,
      config.workspace,
    );
    const record = options.registry.getSymposiumSeatSandbox(
      execution.sessionId,
      execution.seat.id,
      snapshot.generation,
    );
    if (
      !record ||
      record.state !== 'ready' ||
      !record.creationStarted ||
      !record.creationCompleted ||
      !record.physicalId ||
      record.sessionId !== execution.sessionId ||
      record.seatId !== execution.seat.id ||
      record.generation !== execution.provenance.membershipGeneration ||
      record.runtimeId !== snapshot.runtimeId ||
      record.workspace !== config.workspace ||
      record.providerName !== current.provider ||
      record.providerId !== current.providerId ||
      record.providerType !== 'codex' ||
      record.model !== current.model ||
      record.sandboxName !== sandbox.sandboxName ||
      record.sandboxName !== sandboxNameForConversation(snapshot.runtimeId, config.sandboxIdLength)
    )
      throw new Error('Subscription physical seat registry changed');
    const carriedId = (sandbox as Input['sandbox'] & { sandboxId?: string }).sandboxId;
    if (carriedId !== record.physicalId)
      throw new Error('Subscription physical sandbox ID changed');
    const physical = Sandbox.parse(
      JSON.parse(invoke(['sandbox', ...base, 'get', sandbox.sandboxName, '--output', 'json'])),
    );
    const owner = createHash('sha256').update(snapshot.runtimeId).digest('hex').slice(0, 63);
    if (
      physical.id !== record.physicalId ||
      physical.name !== record.sandboxName ||
      physical.workspace !== config.workspace ||
      physical.labels['mitzo.conversation'] !== owner
    )
      throw new Error('Subscription physical sandbox identity or ownership changed');
    const attached: { name: string; type: string }[] = [];
    let token = '';
    const seen = new Set<string>();
    do {
      const page = Attachments.parse(
        JSON.parse(
          invoke([
            'sandbox',
            ...base,
            'provider',
            'list',
            sandbox.sandboxName,
            '--output',
            'json',
            '--page-size',
            '100',
            ...(token ? ['--page-token', token] : []),
          ]),
        ),
      );
      attached.push(...page.providers);
      token = page.next_page_token;
      if (token && (seen.has(token) || seen.size >= 100))
        throw new Error('Subscription attachment pagination changed');
      if (token) seen.add(token);
    } while (token);
    if (
      attached.length !== 1 ||
      attached[0].name !== current.provider ||
      attached[0].type !== 'codex'
    )
      throw new Error('Subscription sandbox provider attachment changed');
    snapshot.verify();
    const latest = options.registry.getSymposiumSeatSandbox(
      execution.sessionId,
      execution.seat.id,
      snapshot.generation,
    );
    if (JSON.stringify(latest) !== JSON.stringify(record))
      throw new Error('Subscription physical seat registry changed during proof');
    if (
      JSON.stringify(
        admitSymposiumSeatDispatch(
          options.facts,
          options.currentProfiles(),
          execution,
          options.hostGrants,
        ),
      ) !== JSON.stringify(current)
    )
      throw new Error('Subscription admission changed during proof');
    options.verifyGatewayCustody();
  };
  return { assertCurrent, verify: async (input: Input) => assertCurrent(input) };
}
