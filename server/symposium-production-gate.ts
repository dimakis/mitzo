import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** First capability contract covers OpenAI writer seats only. A future Claude
 * contract needs independent /usr/local/bin/claude, Vertex Haiku profile,
 * negative isolation, and host proof before widening admission.
 */
const Attestation = z.object({
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
  artifactVolume: z.object({ driver: z.enum(['podman', 'docker']), name: z.string().min(1) }),
  allowedRoles: z.array(z.enum(['implementer', 'coder'])).min(1),
  allowedAccountProviders: z.tuple([z.literal('openai')]),
}).strict();

export type SymposiumProductionAttestation = z.infer<typeof Attestation>;

/** These checks must inspect the selected host/gateway/driver, never sandbox output. */
export interface SymposiumProductionPhysicalProof {
  verifyImageAndController(image: string, imageDigest: string, controllerPath: string, controllerSha256: string): void;
  verifyProviderProfile(name: string, sha256: string, workspace: string): void;
  verifyGatewayDriverConfig(gateway: string, workspace: string, driver: 'podman' | 'docker'): void;
  verifyArtifactVolume(driver: 'podman' | 'docker', name: string, workspace: string): void;
}

type RunCli = (cli: string, args: string[]) => string;
const runCli: RunCli = (cli, args) => {
  const result = spawnSync(cli, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
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
): { runtimeConfig: OpenShellRuntimeConfig; allowedRoles: ReadonlySet<'implementer' | 'coder'>;
  allowedAccountProviders: ReadonlySet<'openai'>; attestedProviderProfiles: ReadonlySet<string> } {
  const expected = Attestation.parse(attestation);
  const profileNames = expected.providerProfiles.map((profile) => profile.name);
  if (new Set(profileNames).size !== profileNames.length)
    throw new Error('Symposium attested provider profile names must be unique');
  if (!physical) throw new Error('Symposium physical gateway and volume proof is unavailable');
  if (legacyConfig.cliContract || legacyConfig.artifactDriverConfig || legacyConfig.verifyArtifactMount)
    throw new Error('Symposium gate requires an unmodified base runtime config');
  if (legacyConfig.gateway !== expected.gateway || legacyConfig.workspace !== expected.workspace ||
      legacyConfig.image !== expected.image || legacyConfig.gatewayInsecure ||
      legacyConfig.serviceProviders.length || legacyConfig.grantableServiceProviders.length)
    throw new Error('Symposium runtime differs from operator attestation');
  if (digestFile(legacyConfig.cli) !== expected.cliSha256)
    throw new Error('OpenShell CLI digest changed');
  if (digestFile(legacyConfig.policy) !== expected.policySha256 ||
      digestSymposiumSeedTree(legacyConfig.seed) !== expected.seedTreeSha256)
    throw new Error('Symposium policy or seed digest changed');
  const version = invoke(legacyConfig.cli, ['--version']);
  if (version !== `openshell ${expected.cliVersion}`)
    throw new Error('OpenShell CLI version changed');
  const target = legacyConfig.gatewayEndpoint
    ? ['--gateway-endpoint', legacyConfig.gatewayEndpoint]
    : ['--gateway', legacyConfig.gateway];
  const gateway = JSON.parse(invoke(legacyConfig.cli, [
    'gateway', 'info', ...target, '--workspace', legacyConfig.workspace, '--output', 'json',
  ]));
  if (!gateway || gateway.gateway !== expected.gateway ||
      gateway.version !== expected.gatewayVersion || gateway.status !== 'healthy' ||
      (legacyConfig.gatewayEndpoint && gateway.server !== legacyConfig.gatewayEndpoint) ||
      !Array.isArray(gateway.compute_drivers) ||
      !gateway.compute_drivers.some((driver: { name?: string; capabilities?: { driver_version?: string } }) =>
        driver.name === expected.artifactVolume.driver && driver.capabilities?.driver_version === expected.gatewayVersion))
    throw new Error('Selected OpenShell gateway or compute driver changed');
  physical.verifyImageAndController(expected.image, expected.imageDigest,
    expected.controllerPath, expected.controllerSha256);
  for (const profile of expected.providerProfiles)
    physical.verifyProviderProfile(profile.name, profile.sha256, expected.workspace);
  physical.verifyGatewayDriverConfig(expected.gateway, expected.workspace, expected.artifactVolume.driver);
  physical.verifyArtifactVolume(expected.artifactVolume.driver, expected.artifactVolume.name, expected.workspace);
  return {
    runtimeConfig: { ...legacyConfig, cliContract: 'v0.1' },
    allowedRoles: new Set(expected.allowedRoles),
    allowedAccountProviders: new Set(expected.allowedAccountProviders),
    attestedProviderProfiles: new Set(profileNames),
  };
}
