import type { SymposiumWorkVertexReceipt } from './symposium-work-vertex-provider.js';
import {
  REVIEWED_SYMPOSIUM_OWNED_RUNTIME,
  REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME,
  REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME,
  REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME,
  reviewedSymposiumOwnedRuntime,
} from './symposium-owned-runtime-contract.js';
import {
  validateOpenShellCliEnvironment,
  type OpenShellCliEnvironment,
} from './openshell-cli-environment.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** First capability contract covers OpenAI API writer seats only. Personal ChatGPT
 * subscription admission needs independent upstream provider/authentication and
 * per-seat credential isolation evidence; an API attestation cannot authorize it.
 * Owned Claude uses a separate exact native image and retained Vertex capability;
 * this legacy API contract grants no Claude admission.
 */
const LegacyAttestation = z
  .object({
    contract: z.literal('openshell-v0.1-openai-seat'),
    cliVersion: z.string().regex(/^0\.1\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/),
    cliSha256: Sha256,
    gatewayVersion: z.string().regex(/^0\.1\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/),
    gateway: z.string().min(1),
    workspace: z.string().min(1),
    image: z.string().min(1),
    imageDigest: Sha256,
    // Exact reviewed derivation base. Vertex effective seat policies are derived
    // and checked separately by the retained owner, never equated to this hash.
    policySha256: Sha256,
    seedTreeSha256: Sha256,
    controllerPath: z.literal('/usr/bin/codex'),
    controllerSha256: Sha256,
    providerProfiles: z.array(z.object({ name: z.string().min(1), sha256: Sha256 })).min(1),
    providerInstances: z
      .array(
        z
          .object({
            name: z.string().min(1),
            id: z.string().min(1),
            type: z.literal('openai'),
            profileName: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    artifactVolume: z.object({ driver: z.enum(['podman', 'docker']), name: z.string().min(1) }),
    allowedRoles: z.array(z.enum(['implementer', 'coder'])).min(1),
    allowedAccountProviders: z.tuple([z.literal('openai')]),
  })
  .strict();

/** Only this exact upstream development build and reviewed native artifacts have
 * passed the owned-gateway transport, authentication and filesystem canaries. */
export const TESTED_SYMPOSIUM_NATIVE_BUILD = REVIEWED_SYMPOSIUM_OWNED_RUNTIME.build;
const reviewed = TESTED_SYMPOSIUM_NATIVE_BUILD;
const claudeReviewed = REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build;
const codeModeReviewed = REVIEWED_SYMPOSIUM_CODE_MODE_RUNTIME.build;
const codex01561Reviewed = REVIEWED_SYMPOSIUM_CODEX_01561_RUNTIME.build;
const OwnedAttestation = LegacyAttestation.extend({
  contract: z.literal('openshell-v0.1-owned-native-seats'),
  cliVersion: z.literal(reviewed.version),
  cliSha256: z.literal(reviewed.cliSha256),
  gatewayVersion: z.literal(reviewed.version),
  gatewaySha256: z.literal(reviewed.gatewaySha256),
  gatewayEndpoint: z.string().url(),
  image: z.enum([
    reviewed.image,
    claudeReviewed.image,
    codeModeReviewed.image,
    codex01561Reviewed.image,
  ]),
  imageDigest: z.enum([
    reviewed.imageDigest,
    claudeReviewed.imageDigest,
    codeModeReviewed.imageDigest,
    codex01561Reviewed.imageDigest,
  ]),
  controllerSha256: z.enum([
    reviewed.nativeArtifacts['/usr/bin/codex'],
    codeModeReviewed.nativeArtifacts['/usr/bin/codex'],
    codex01561Reviewed.nativeArtifacts['/usr/bin/codex'],
  ]),
  sandboxRuntimeImage: z.literal(reviewed.sandboxRuntimeImage),
  supervisorImage: z.literal(reviewed.supervisorImage),
  nativeArtifacts: z
    .object({
      '/usr/bin/codex': z.enum([
        reviewed.nativeArtifacts['/usr/bin/codex'],
        codeModeReviewed.nativeArtifacts['/usr/bin/codex'],
        codex01561Reviewed.nativeArtifacts['/usr/bin/codex'],
      ]),
      '/usr/bin/codex-code-mode-host': z
        .enum([
          codeModeReviewed.nativeArtifacts['/usr/bin/codex-code-mode-host'],
          codex01561Reviewed.nativeArtifacts['/usr/bin/codex-code-mode-host'],
        ])
        .optional(),
      '/usr/local/bin/symposium-attempt-controller': z.literal(
        reviewed.nativeArtifacts['/usr/local/bin/symposium-attempt-controller'],
      ),
      '/usr/local/bin/symposium-seat-landlock': z.enum([
        reviewed.nativeArtifacts['/usr/local/bin/symposium-seat-landlock'],
        claudeReviewed.nativeArtifacts['/usr/local/bin/symposium-seat-landlock'],
        codex01561Reviewed.nativeArtifacts['/usr/local/bin/symposium-seat-landlock'],
      ]),
      '/usr/local/bin/claude': z
        .literal(claudeReviewed.nativeArtifacts['/usr/local/bin/claude'])
        .optional(),
      '/usr/local/bin/symposium-claude-vertex': z
        .literal(claudeReviewed.nativeArtifacts['/usr/local/bin/symposium-claude-vertex'])
        .optional(),
      '/usr/local/bin/symposium-subscription-app-server': z.literal(
        reviewed.nativeArtifacts['/usr/local/bin/symposium-subscription-app-server'],
      ),
    })
    .strict(),
  providerInstances: z
    .array(
      z
        .object({
          name: z.string().min(1),
          id: z.string().min(1),
          type: z.enum(['openai', 'codex', 'google-vertex-ai']),
          profileName: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
  artifactVolume: z.object({ driver: z.literal('podman'), name: z.string().min(1) }).strict(),
  allowedRoles: z.array(z.enum(['implementer', 'coder', 'reviewer'])).min(1),
  allowedAccountProviders: z.array(z.enum(['openai', 'openai-codex', 'anthropic-vertex'])).min(1),
})
  .strict()
  .superRefine((value, context) => {
    const expected = reviewedSymposiumOwnedRuntime(value.image).build;
    const artifacts = Object.entries(value.nativeArtifacts);
    if (
      value.imageDigest !== expected.imageDigest ||
      value.controllerSha256 !== expected.nativeArtifacts['/usr/bin/codex'] ||
      artifacts.length !== Object.keys(expected.nativeArtifacts).length ||
      artifacts.some(
        ([path, hash]) => (expected.nativeArtifacts as Record<string, string>)[path] !== hash,
      ) ||
      (value.image !== claudeReviewed.image &&
        (value.allowedAccountProviders.includes('anthropic-vertex') ||
          value.providerInstances.some((p) => p.type === 'google-vertex-ai')))
    )
      context.addIssue({
        code: 'custom',
        message: 'Owned native runtime variant differs from reviewed contract',
      });
  });
const Attestation = z.discriminatedUnion('contract', [LegacyAttestation, OwnedAttestation]);
export type SymposiumProductionAttestation = z.infer<typeof Attestation>;
export interface SymposiumOwnedNativeHostBinding {
  cli: string;
  cliEnvironment: OpenShellCliEnvironment;
  cliSha256: string;
  gatewaySha256: string;
  gateway: string;
  workspace: string;
  gatewayEndpoint: string;
  image: string;
  sandboxRuntimeImage: string;
  supervisorImage: string;
}

/** These checks must inspect the selected host/gateway/driver, never sandbox output. */
export interface SymposiumProductionPhysicalProof {
  /** Mandatory for owned-native contracts; unavailable evidence is never inferred. */
  verifyOwnedNativeHost?(binding: SymposiumOwnedNativeHostBinding): void;
  /** Same-process selected identity capability, never reconstructed from attestation text. */
  captureClaudeProvider?(providerId: string): SymposiumWorkVertexReceipt;
  verifyNativeArtifacts?(
    image: string,
    imageDigest: string,
    artifacts: Readonly<Record<string, string>>,
  ): void;
  verifyImageAndController(
    image: string,
    imageDigest: string,
    controllerPath: string,
    controllerSha256: string,
  ): void;
  verifyProviderProfile(name: string, sha256: string, workspace: string): void;
  /** Prove this exact live instance uses the reviewed profile, not just its provider type. */
  verifyProviderInstance(binding: {
    name: string;
    id: string;
    type: string;
    profileName: string;
    profileSha256: string;
    workspace: string;
  }): void;
  verifyGatewayDriverConfig(gateway: string, workspace: string, driver: 'podman' | 'docker'): void;
  verifyArtifactVolume(driver: 'podman' | 'docker', name: string, workspace: string): void;
}

export interface SymposiumProviderCapability {
  claudeProviders?: ReadonlyMap<string, SymposiumWorkVertexReceipt>;
  attestedProviderInstances: ReadonlyMap<
    string,
    {
      id: string;
      type: string;
      profileName: string;
      workspace: string;
    }
  >;
}

export function assertSymposiumAttestedProvider(
  capability: SymposiumProviderCapability,
  binding: { name: string; id: string; type: string; workspace?: string },
): void {
  const approved = capability.attestedProviderInstances?.get(binding.name);
  if (
    !approved ||
    approved.id !== binding.id ||
    approved.type !== binding.type ||
    (binding.workspace !== undefined && approved.workspace !== binding.workspace)
  )
    throw new Error('Seat provider profile is outside the host attestation');
}

export function assertSymposiumAttestedClaudeProvider(
  capability: SymposiumProviderCapability | undefined,
  binding: {
    accountId: string;
    provider: string;
    providerId: string;
    projectId: string;
    region: string;
    model: string;
    workspace?: string;
  },
): void {
  const receipt = capability?.claudeProviders?.get(binding.provider);
  if (
    !receipt ||
    !receipt.principal ||
    receipt.accountId !== binding.accountId ||
    receipt.provider !== binding.provider ||
    receipt.providerId !== binding.providerId ||
    receipt.projectId !== binding.projectId ||
    receipt.region !== binding.region ||
    receipt.model !== binding.model ||
    (binding.workspace !== undefined && receipt.workspace !== binding.workspace)
  )
    throw new Error('Claude seat is outside the retained Vertex capability');
  assertSymposiumAttestedProvider(capability!, {
    name: binding.provider,
    id: binding.providerId,
    type: 'google-vertex-ai',
    workspace: receipt.workspace,
  });
}

type RunCli = (cli: string, args: string[], cliEnvironment?: OpenShellCliEnvironment) => string;
const runCli: RunCli = (cli, args, cliEnvironment) => {
  const result = spawnSync(cli, args, {
    ...(cliEnvironment ? { env: validateOpenShellCliEnvironment(cliEnvironment) } : {}),
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('OpenShell capability probe failed');
  return result.stdout.trim();
};

const digestFile = (path: string) => {
  if (!isAbsolute(path)) throw new Error('Capability file path must be absolute');
  if (!lstatSync(path).isFile()) throw new Error('Capability path must be a regular file');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};

/** Stable digest of the complete seed directory, including empty directories.
 * Reject links and special files so an attested tree cannot change by indirection.
 */
export function digestSymposiumSeedTree(root: string): string {
  if (!isAbsolute(root) || !lstatSync(root).isDirectory())
    throw new Error('Symposium seed must be an absolute directory');
  const hash = createHash('sha256');
  const visit = (directory: string, relative: string) => {
    hash.update(`D\0${relative}\0`);
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symposium seed cannot contain symbolic links');
      if (stat.isDirectory()) visit(path, child);
      else if (stat.isFile()) hash.update(`F\0${child}\0${digestFile(path)}\0`);
      else throw new Error('Symposium seed contains a special file');
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

export function readSymposiumProductionAttestation(path: string): SymposiumProductionAttestation {
  if (!isAbsolute(path)) throw new Error('Symposium attestation path must be absolute');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Symposium attestation must be a private host file');
  return Attestation.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** All proofs are required before a 0.1 Symposium runtime can admit any seat. */
export function verifySymposiumProductionGate(
  legacyConfig: OpenShellRuntimeConfig,
  attestation: SymposiumProductionAttestation,
  physical: SymposiumProductionPhysicalProof | undefined,
  invoke: RunCli = runCli,
): {
  runtimeConfig: OpenShellRuntimeConfig;
  allowedRoles: ReadonlySet<'implementer' | 'coder' | 'reviewer'>;
  allowedAccountProviders: ReadonlySet<'openai' | 'openai-codex' | 'anthropic-vertex'>;
  claudeProviders: ReadonlyMap<string, SymposiumWorkVertexReceipt>;
  readOnlyEnforced: boolean;
  attestedProviderProfiles: ReadonlySet<string>;
  attestedProviderInstances: SymposiumProviderCapability['attestedProviderInstances'];
} {
  if (
    attestation.contract !== 'openshell-v0.1-owned-native-seats' &&
    attestation.allowedAccountProviders?.some((provider: string) => provider === 'openai-codex')
  )
    throw new Error('Personal ChatGPT subscription production evidence is unavailable');
  const expected = Attestation.parse(attestation);
  const owned = expected.contract === 'openshell-v0.1-owned-native-seats';
  let ownedBinding: SymposiumOwnedNativeHostBinding | undefined;
  if (owned) {
    if (
      !physical?.verifyOwnedNativeHost ||
      !physical.verifyNativeArtifacts ||
      !legacyConfig.cliEnvironment
    )
      throw new Error('Owned native host and artifact proof is unavailable');
    if (legacyConfig.gatewayEndpoint)
      throw new Error('Owned native host requires its private named gateway route');
    if (
      new Set(expected.allowedRoles).size !== expected.allowedRoles.length ||
      new Set(expected.allowedAccountProviders).size !== expected.allowedAccountProviders.length
    )
      throw new Error('Owned native admission lists must be unique');
    for (const provider of expected.allowedAccountProviders) {
      const type =
        provider === 'openai-codex'
          ? 'codex'
          : provider === 'anthropic-vertex'
            ? 'google-vertex-ai'
            : 'openai';
      if (
        !expected.providerInstances.some(
          (instance) => instance.type === type && instance.profileName === type,
        )
      )
        throw new Error('Owned native account provider lacks an attested instance');
    }
    ownedBinding = {
      cli: legacyConfig.cli,
      cliEnvironment: validateOpenShellCliEnvironment(legacyConfig.cliEnvironment),
      cliSha256: expected.cliSha256,
      gatewaySha256: expected.gatewaySha256,
      gateway: expected.gateway,
      workspace: expected.workspace,
      gatewayEndpoint: expected.gatewayEndpoint,
      image: expected.image,
      sandboxRuntimeImage: expected.sandboxRuntimeImage,
      supervisorImage: expected.supervisorImage,
    };
    physical.verifyOwnedNativeHost(ownedBinding);
  }
  const profileNames = expected.providerProfiles.map((profile) => profile.name);
  if (new Set(profileNames).size !== profileNames.length)
    throw new Error('Symposium attested provider profile names must be unique');
  const instanceNames = expected.providerInstances.map((instance) => instance.name);
  const instanceIds = expected.providerInstances.map((instance) => instance.id);
  if (
    new Set(instanceNames).size !== instanceNames.length ||
    new Set(instanceIds).size !== instanceIds.length
  )
    throw new Error('Symposium attested provider instances must be unique');
  if (expected.providerInstances.some((instance) => !profileNames.includes(instance.profileName)))
    throw new Error('Symposium provider instance references an unattested profile');
  if (!physical || typeof physical.verifyProviderInstance !== 'function')
    throw new Error('Symposium physical gateway and volume proof is unavailable');
  if (
    legacyConfig.cliContract ||
    legacyConfig.artifactDriverConfig ||
    legacyConfig.verifyArtifactMount
  )
    throw new Error('Symposium gate requires an unmodified base runtime config');
  if (
    legacyConfig.gateway !== expected.gateway ||
    legacyConfig.workspace !== expected.workspace ||
    legacyConfig.image !== expected.image ||
    legacyConfig.gatewayInsecure ||
    legacyConfig.serviceProviders.length ||
    legacyConfig.grantableServiceProviders.length
  )
    throw new Error('Symposium runtime differs from operator attestation');
  if (digestFile(legacyConfig.cli) !== expected.cliSha256)
    throw new Error('OpenShell CLI digest changed');
  if (
    digestFile(legacyConfig.policy) !== expected.policySha256 ||
    digestSymposiumSeedTree(legacyConfig.seed) !== expected.seedTreeSha256
  )
    throw new Error('Symposium policy or seed digest changed');
  const version = invoke(legacyConfig.cli, ['--version'], legacyConfig.cliEnvironment);
  if (version !== `openshell ${expected.cliVersion}`)
    throw new Error('OpenShell CLI version changed');
  const target = legacyConfig.gatewayEndpoint
    ? ['--gateway-endpoint', legacyConfig.gatewayEndpoint]
    : ['--gateway', legacyConfig.gateway];
  const gateway = JSON.parse(
    invoke(
      legacyConfig.cli,
      ['gateway', 'info', ...target, '--workspace', legacyConfig.workspace, '--output', 'json'],
      legacyConfig.cliEnvironment,
    ),
  );
  if (
    !gateway ||
    gateway.gateway !== expected.gateway ||
    gateway.version !== expected.gatewayVersion ||
    gateway.status !== 'healthy' ||
    (legacyConfig.gatewayEndpoint && gateway.server !== legacyConfig.gatewayEndpoint) ||
    (owned && gateway.server !== expected.gatewayEndpoint) ||
    !Array.isArray(gateway.compute_drivers) ||
    !gateway.compute_drivers.some(
      (driver: { name?: string; capabilities?: { driver_version?: string } }) =>
        driver.name === expected.artifactVolume.driver &&
        driver.capabilities?.driver_version === expected.gatewayVersion,
    )
  )
    throw new Error('Selected OpenShell gateway or compute driver changed');
  physical.verifyImageAndController(
    expected.image,
    expected.imageDigest,
    expected.controllerPath,
    expected.controllerSha256,
  );
  if (owned)
    physical.verifyNativeArtifacts!(expected.image, expected.imageDigest, expected.nativeArtifacts);
  for (const profile of expected.providerProfiles)
    physical.verifyProviderProfile(profile.name, profile.sha256, expected.workspace);
  for (const instance of expected.providerInstances)
    physical.verifyProviderInstance({
      ...instance,
      profileSha256: expected.providerProfiles.find(
        (profile) => profile.name === instance.profileName,
      )!.sha256,
      workspace: expected.workspace,
    });
  physical.verifyGatewayDriverConfig(
    expected.gateway,
    expected.workspace,
    expected.artifactVolume.driver,
  );
  physical.verifyArtifactVolume(
    expected.artifactVolume.driver,
    expected.artifactVolume.name,
    expected.workspace,
  );
  if (ownedBinding) physical.verifyOwnedNativeHost!(ownedBinding);
  const claudeProviders = new Map<string, SymposiumWorkVertexReceipt>();
  for (const instance of expected.providerInstances) {
    if (instance.type !== 'google-vertex-ai') continue;
    if (!owned || expected.image !== claudeReviewed.image || !physical.captureClaudeProvider)
      throw new Error('Claude selected provider proof is unavailable');
    const receipt = physical.captureClaudeProvider(instance.id);
    if (
      receipt.provider !== instance.name ||
      receipt.providerId !== instance.id ||
      receipt.workspace !== expected.workspace
    )
      throw new Error('Claude selected provider identity changed');
    claudeProviders.set(instance.name, receipt);
  }
  return {
    claudeProviders,
    readOnlyEnforced: owned,
    runtimeConfig: { ...legacyConfig, cliContract: 'v0.1' },
    allowedRoles: new Set(expected.allowedRoles),
    allowedAccountProviders: new Set(expected.allowedAccountProviders),
    attestedProviderProfiles: new Set(profileNames),
    attestedProviderInstances: new Map(
      expected.providerInstances.map((instance) => [
        instance.name,
        {
          id: instance.id,
          type: instance.type,
          profileName: instance.profileName,
          workspace: expected.workspace,
        },
      ]),
    ),
  };
}
