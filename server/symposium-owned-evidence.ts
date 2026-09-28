import { reviewedSymposiumOwnedRuntime } from './symposium-owned-runtime-contract.js';
import { z } from 'zod';
import { PersonalEvidenceSelection } from './symposium-personal-evidence.js';
import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import { digestSymposiumPublicProfile } from './symposium-production-physical.js';
import {
  OwnedEvidenceVerificationError,
  type OwnedEvidencePhase,
} from './symposium-owned-evidence-diagnostic.js';
import {
  digestSymposiumSeedTree,
  TESTED_SYMPOSIUM_NATIVE_BUILD,
  verifySymposiumProductionGate,
  type SymposiumProductionAttestation,
  type SymposiumProductionPhysicalProof,
} from './symposium-production-gate.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const OwnedEvidenceSelection = z
  .object({
    providerInstances: z
      .array(
        z
          .object({
            name: identifier,
            id: identifier,
            type: z.enum(['openai', 'codex', 'google-vertex-ai']),
            profileName: z.enum(['openai', 'codex', 'google-vertex-ai']),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    artifactVolume: z.object({ driver: z.literal('podman'), name: identifier }).strict(),
    allowedRoles: z
      .array(z.enum(['implementer', 'coder', 'reviewer']))
      .min(1)
      .max(3),
    allowedAccountProviders: z
      .array(z.enum(['openai', 'openai-codex', 'anthropic-vertex']))
      .min(1)
      .max(3),
  })
  .strict();
type Invoke = NonNullable<Parameters<typeof verifySymposiumProductionGate>[3]>;
export const invokeOwnedEvidenceCli: Invoke = (cli, args, environment) => {
  if (!environment) throw new Error('Owned CLI environment missing');
  const env = validateOpenShellCliEnvironment(environment);
  for (const key of [
    'OPENSHELL_GATEWAY',
    'OPENSHELL_GATEWAY_ENDPOINT',
    'OPENSHELL_GATEWAY_INSECURE',
    'OPENSHELL_WORKSPACE',
  ])
    delete env[key];
  const result = spawnSync(cli, args, {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Public profile evidence unavailable');
  return result.stdout.trim();
};

/** Candidate only: the retained host supplies custody and physical verification.
 * No filesystem destination or activation capability is accepted here. */
export function collectOwnedAdmissionEvidence(
  host: {
    config: OpenShellRuntimeConfig;
    endpoint: string;
    physical: SymposiumProductionPhysicalProof;
    custody(): void;
  },
  selection: unknown,
  dependencies: {
    invoke?: Invoke;
    verify?: typeof verifySymposiumProductionGate;
    onPhase?: (phase: OwnedEvidencePhase) => void;
  } = {},
): SymposiumProductionAttestation {
  dependencies.onPhase?.('selection');
  const selected = OwnedEvidenceSelection.parse(selection);
  for (const instance of selected.providerInstances)
    if (instance.type !== instance.profileName)
      throw new Error('Provider and public profile differ');
  dependencies.onPhase?.('custody');
  host.custody();
  const invoke = dependencies.invoke ?? invokeOwnedEvidenceCli;
  const config = host.config;
  dependencies.onPhase?.('local-inputs');
  const policy = lstatSync(config.policy);
  if (!policy.isFile() || policy.isSymbolicLink()) throw new Error('Policy must be a regular file');
  const build = reviewedSymposiumOwnedRuntime(
    config.image ?? TESTED_SYMPOSIUM_NATIVE_BUILD.image,
  ).build;
  const candidate: SymposiumProductionAttestation = {
    contract: 'openshell-v0.1-owned-native-seats',
    cliVersion: build.version,
    cliSha256: build.cliSha256,
    gatewayVersion: build.version,
    gatewaySha256: build.gatewaySha256,
    gateway: config.gateway,
    workspace: config.workspace,
    gatewayEndpoint: host.endpoint,
    image: build.image,
    imageDigest: build.imageDigest,
    sandboxRuntimeImage: build.sandboxRuntimeImage,
    supervisorImage: build.supervisorImage,
    nativeArtifacts: { ...build.nativeArtifacts },
    controllerPath: '/usr/bin/codex',
    controllerSha256: build.nativeArtifacts['/usr/bin/codex'],
    policySha256: createHash('sha256').update(readFileSync(config.policy)).digest('hex'),
    seedTreeSha256: digestSymposiumSeedTree(config.seed),
    providerProfiles: [
      ...new Set(selected.providerInstances.map((instance) => instance.profileName)),
    ].map((name) => {
      dependencies.onPhase?.('profile-export');
      return {
        name,
        sha256: digestSymposiumPublicProfile(
          JSON.parse(
            invoke(
              config.cli,
              [
                'profile',
                'export',
                name,
                '--output',
                'json',
                '--gateway',
                config.gateway,
                '--workspace',
                config.workspace,
              ],
              config.cliEnvironment,
            ),
          ),
        ),
      };
    }),
    ...selected,
  };
  dependencies.onPhase?.('gate');
  (dependencies.verify ?? verifySymposiumProductionGate)(config, candidate, host.physical, invoke);
  dependencies.onPhase?.('custody');
  host.custody();
  return candidate;
}

/** Authentication is attached by app.ts using operatorAuthMiddleware. */
export function ownedEvidenceHandler(
  resolve: () => ((selection: unknown) => Promise<SymposiumProductionAttestation>) | undefined,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const collect = resolve();
    if (!collect) {
      res.status(503).json({ error: 'Owned admission evidence collection is unavailable.' });
      return;
    }
    const parsed = z.union([OwnedEvidenceSelection, PersonalEvidenceSelection]).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Provide exact provider instances, roles, account providers, and artifact volume.',
      });
      return;
    }
    try {
      res.json({ candidate: await collect(parsed.data), activated: false });
    } catch (error) {
      res.status(409).json({
        error: 'Evidence could not be verified. Check the explicit selection and owned host.',
        ...(error instanceof OwnedEvidenceVerificationError && error.phase
          ? { phase: error.phase }
          : {}),
      });
    }
  };
}
