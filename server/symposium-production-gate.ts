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
 * A future Claude
 * contract needs independent /usr/local/bin/claude, Vertex Haiku profile,
 * negative isolation, and host proof before widening admission.
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
export const TESTED_SYMPOSIUM_NATIVE_BUILD = {
  version: '0.0.117-dev.292+g854b2370b',
  cliSha256: '5a02cb78ef641da6badec1901677d4478c059a0080dbf4de13a6bbc503588dc8',
  gatewaySha256: '281a4873ec62ddb384db2b495a324d5a899e27944500c309191195463cd2422e',
  image: 'sha256:c621f4a66281689c9d4c2692ca7234ba61cd154f58c3df003a193f58375bb63d',
  imageDigest: 'd00a366614f1926d7159a5290818418b041167295ba2e93692ce47a38e06448f',
  sandboxRuntimeImage: 'sha256:ea1fa3016afc3029d5cef331a92f3fb1383f03799221aec920248d06f4aba1dd',
  supervisorImage: 'sha256:8df2e97c2b25b75031b4c00cb49e4cd487ba2384ebe7d884a0aa12095be20937',
  nativeArtifacts: {
    '/usr/bin/codex': '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70',
    '/usr/local/bin/symposium-attempt-controller':
      'd9f995cd0871ca63be4efa3c5d5760094af9c07496e1acf5d838acf8b55f2209',
    '/usr/local/bin/symposium-seat-landlock':
      'bf31950c31eafab27d54ddd3662e450769811ea906687616217d743d3134c96d',
    '/usr/local/bin/symposium-subscription-app-server':
      'ffb14857502305d354143e475ad8b417aa733857254b6d3e34b66023e444adfb',
  },
} as const;
const reviewed = TESTED_SYMPOSIUM_NATIVE_BUILD;
const OwnedAttestation = LegacyAttestation.extend({
  contract: z.literal('openshell-v0.1-owned-native-seats'),
  cliVersion: z.literal(reviewed.version),
  cliSha256: z.literal(reviewed.cliSha256),
  gatewayVersion: z.literal(reviewed.version),
  gatewaySha256: z.literal(reviewed.gatewaySha256),
  gatewayEndpoint: z.string().url(),
  image: z.literal(reviewed.image),
  imageDigest: z.literal(reviewed.imageDigest),
  controllerSha256: z.literal(reviewed.nativeArtifacts['/usr/bin/codex']),
  sandboxRuntimeImage: z.literal(reviewed.sandboxRuntimeImage),
  supervisorImage: z.literal(reviewed.supervisorImage),
  nativeArtifacts: z
    .object({
      '/usr/bin/codex': z.literal(reviewed.nativeArtifacts['/usr/bin/codex']),
      '/usr/local/bin/symposium-attempt-controller': z.literal(
        reviewed.nativeArtifacts['/usr/local/bin/symposium-attempt-controller'],
      ),
      '/usr/local/bin/symposium-seat-landlock': z.literal(
        reviewed.nativeArtifacts['/usr/local/bin/symposium-seat-landlock'],
      ),
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
          type: z.enum(['openai', 'codex']),
          profileName: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
  artifactVolume: z.object({ driver: z.literal('podman'), name: z.string().min(1) }).strict(),
  allowedRoles: z.array(z.enum(['implementer', 'coder', 'reviewer'])).min(1),
  allowedAccountProviders: z.array(z.enum(['openai', 'openai-codex'])).min(1),
}).strict();
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
  allowedAccountProviders: ReadonlySet<'openai' | 'openai-codex'>;
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
      const type = provider === 'openai-codex' ? 'codex' : 'openai';
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
  return {
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
