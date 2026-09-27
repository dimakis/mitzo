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
            type: z.enum(['openai', 'codex']),
            profileName: z.enum(['openai', 'codex']),
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
      .array(z.enum(['openai', 'openai-codex']))
      .min(1)
      .max(2),
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
  dependencies: { invoke?: Invoke; verify?: typeof verifySymposiumProductionGate } = {},
): SymposiumProductionAttestation {
  const selected = OwnedEvidenceSelection.parse(selection);
  for (const instance of selected.providerInstances)
    if (instance.type !== instance.profileName)
      throw new Error('Provider and public profile differ');
  host.custody();
  const invoke = dependencies.invoke ?? invokeOwnedEvidenceCli;
  const config = host.config;
  const policy = lstatSync(config.policy);
  if (!policy.isFile() || policy.isSymbolicLink()) throw new Error('Policy must be a regular file');
  const build = TESTED_SYMPOSIUM_NATIVE_BUILD;
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
    ].map((name) => ({
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
    })),
    ...selected,
  };
  (dependencies.verify ?? verifySymposiumProductionGate)(config, candidate, host.physical, invoke);
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
    } catch {
      res.status(409).json({
        error: 'Evidence could not be verified. Check the explicit selection and owned host.',
      });
    }
  };
}
