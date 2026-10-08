import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
import type { SymposiumCustodianConstructorHooks } from './symposium-custodian-main.js';
import { openStagingRegistry } from './symposium-staging-registry.js';
import { readOwnedSymposiumHostConfig } from './symposium-owned-config-schema.js';

export const StagingLaunchSchema = z.strictObject({
  registryDirectory: z.string().refine(isAbsolute),
  capacity: z.number().int().min(1).max(20),
  ownerChat: z.string(),
  purpose: z.string(),
  retentionReason: z.string(),
  reviewAfter: z.number().int().positive(),
});
// Verification has already validated the private config. Read only directory metadata;
// the registry must not mutate release inputs or any owner-controlled state tree.
function rejectRegistryOverlap(plan: OwnedReleasePlan, directory: string) {
  if (realpathSync(directory) !== directory) throw Error('Private registry required');
  const config = readOwnedSymposiumHostConfig(plan.configPath);
  const contains = (parent: string, child: string) => {
    const r = relative(parent, child);
    return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
  };
  const protectedPaths = [
    plan.releaseRoot,
    plan.repositoryPath,
    plan.planDirectory,
    plan.configPath,
    plan.appHome,
    config.gateway.stateParent,
    config.podman.environment.HOME,
    config.runtime.seed,
    config.runtime.policy,
    config.attestationPath,
    config.gateway.executable,
    config.gateway.cliExecutable,
    config.gateway.systemCaBundle,
    config.gateway.podmanSocket,
    ...Object.values(config.gateway.tls),
    ...Object.values(config.gateway.jwt),
    ...(config.gateway.upstreamProxy ? [config.gateway.upstreamProxy.caBundle] : []),
    config.podman.executable,
    ...(config.podman.environment.XDG_CONFIG_HOME
      ? [config.podman.environment.XDG_CONFIG_HOME]
      : []),
    ...config.providerProfiles.map((profile) => profile.path),
    ...config.personal.workProfiles.flatMap((profile) =>
      profile.provider === 'anthropic-vertex' ? [profile.credentialRef] : [],
    ),
  ];
  // Public inputs may use symlinks. Future attestation paths may not exist yet;
  // resolve their nearest existing ancestor without creating files or reading secrets.
  const canonical = (path: string): string => {
    try {
      lstatSync(path);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      return join(canonical(dirname(path)), basename(path));
    }
    return realpathSync(path);
  };
  protectedPaths.push(...protectedPaths.map(canonical));
  if (protectedPaths.some((p) => contains(directory, p) || contains(p, directory)))
    throw Error('Staging registry overlaps owned release or state paths');
}
/** Same fresh launcher/host lifetime. No existing registration can be resumed. */
export async function launchStagingCustodian(
  plan: OwnedReleasePlan,
  registration: z.infer<typeof StagingLaunchSchema>,
  deps: {
    verify(plan: OwnedReleasePlan): void;
    claim(plan: OwnedReleasePlan): void;
    run(hooks: SymposiumCustodianConstructorHooks): Promise<void>;
  },
) {
  const input = StagingLaunchSchema.parse(registration);
  deps.verify(plan);
  rejectRegistryOverlap(plan, input.registryDirectory);
  const registry = openStagingRegistry(input.registryDirectory, input.capacity);
  let owner: ReturnType<typeof registry.reserve> | undefined;
  let terminal = false;
  try {
    owner = registry.reserve({
      ownerChat: input.ownerChat,
      purpose: input.purpose,
      retentionReason: input.retentionReason,
      reviewAfter: input.reviewAfter,
      planDirectory: plan.planDirectory,
      sourceCommit: plan.sourceCommit,
      buildSha256: plan.buildSha256,
      configSha256: plan.configSha256,
    });
    const original = owner;
    deps.claim(plan);
    deps.verify(plan);
    await deps.run({
      observeController(identity, current) {
        current();
        original.controller(identity);
        current();
      },
      observeRetirement(state, stateParent, identity) {
        if (state === 'retiring') original.retiring(identity);
        else if (state === 'uncertain') original.uncertain();
        else {
          original.retired(stateParent);
          terminal = true;
        }
      },
    });
    if (!terminal) throw Error('Staging retirement remains uncertain');
  } catch (error) {
    if (owner && !terminal) {
      try {
        owner.uncertain();
      } catch {
        /* Interrupted reservation stays held. */
      }
    }
    throw error;
  } finally {
    registry.close();
  }
}
