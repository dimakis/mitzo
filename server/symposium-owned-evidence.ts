import {
  reviewedSymposiumOwnedBuild,
  type SymposiumOwnedBuildSelection,
} from './symposium-owned-runtime-contract.js';
import { z } from 'zod';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import type { AuthSession } from './auth.js';
import { PersonalEvidenceSelection } from './symposium-personal-evidence.js';
import type { Request, Response, RequestHandler } from 'express';
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
export const SessionOwnedEvidenceSelection = OwnedEvidenceSelection.omit({ artifactVolume: true })
  .extend({
    sessionId: identifier,
    configRevision: z.number().int().positive(),
  })
  .strict();
export type SessionOwnedEvidenceInput = z.infer<typeof SessionOwnedEvidenceSelection>;
export interface SessionOwnedEvidenceCapability {
  candidate: SymposiumProductionAttestation;
  assertCurrent(): Promise<void>;
}
/** Constructor-owned draft mapping only. Collection does not issue artifact admission. */
export async function collectSessionOwnedAdmissionEvidence(
  raw: unknown,
  dependencies: {
    readCurrent(input: SessionOwnedEvidenceInput): { volumeName: string; volumeGeneration: string };
    inspectCurrent(
      input: SessionOwnedEvidenceInput,
      mapping: { volumeName: string; volumeGeneration: string },
    ): Promise<void>;
    collect(selection: unknown): Promise<SymposiumProductionAttestation>;
    verifyCandidate(candidate: SymposiumProductionAttestation): void;
  },
): Promise<SessionOwnedEvidenceCapability> {
  const input = SessionOwnedEvidenceSelection.parse(raw);
  const original = { ...dependencies.readCurrent(input) };
  const retained: { candidate?: SymposiumProductionAttestation } = {};
  const assertCurrent = async () => {
    const before = dependencies.readCurrent(input);
    if (
      before.volumeName !== original.volumeName ||
      before.volumeGeneration !== original.volumeGeneration
    )
      throw new Error('Original ready artifact mapping changed');
    await dependencies.inspectCurrent(input, original);
    const after = dependencies.readCurrent(input);
    if (
      after.volumeName !== original.volumeName ||
      after.volumeGeneration !== original.volumeGeneration
    )
      throw new Error('Original ready artifact mapping changed');
    if (retained.candidate) dependencies.verifyCandidate(retained.candidate);
  };
  await assertCurrent();
  const selection = {
    providerInstances: input.providerInstances,
    allowedRoles: input.allowedRoles,
    allowedAccountProviders: input.allowedAccountProviders,
  };
  const candidate = await dependencies.collect({
    ...selection,
    artifactVolume: { driver: 'podman', name: original.volumeName },
  });
  retained.candidate = candidate;
  await assertCurrent();
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(candidate);
  return { candidate, assertCurrent };
}
/** Public scope contains no physical/provider/build authority. */
export const SessionEvidenceRequest = z.strictObject({
  configRevision: z.number().int().positive(),
});
export const SessionEvidenceBinding = SessionEvidenceRequest.extend({
  sessionId: identifier,
}).strict();
/** Same live interactive session and private dispatcher identity, never JSON authority. */
export function sessionEvidenceRequestAuthority(
  req: Request,
  res: Response,
  dependencies: {
    session: AuthSession | undefined;
    hasSession(sessionId: string): boolean;
    register(session: AuthSession, revoked: () => void): () => void;
  },
): () => void {
  const session = dependencies.session;
  if (!session || !dependencies.hasSession(String(req.params.sessionId)))
    throw Error('Original authenticated session required');
  const retained = custodianRequestAuthority(req);
  let current = true;
  const unregister = dependencies.register(session, () => {
    current = false;
  });
  const close = () => {
    current = false;
    unregister();
  };
  res.once('finish', close);
  res.once('close', close);
  return () => {
    try {
      if (!current || res.writableEnded || session.expiresAt <= Date.now())
        throw Error('Session evidence authorization expired');
      if (retained && custodianRequestAuthority(req)?.id !== retained.id)
        throw Error('Custodian evidence authority changed');
    } catch (error) {
      current = false;
      throw error;
    }
  };
}
export function sessionOwnedEvidenceHandler(
  resolve: () =>
    | ((
        binding: z.infer<typeof SessionEvidenceBinding>,
        assertCurrent: () => void,
      ) => Promise<SessionOwnedEvidenceCapability>)
    | undefined,
  authorize: (req: Request, res: Response) => () => void,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const input = SessionEvidenceRequest.safeParse(req.body);
    const binding = input.success
      ? SessionEvidenceBinding.safeParse({ ...input.data, sessionId: req.params.sessionId })
      : null;
    if (!binding?.success || Object.keys(req.query).length) {
      res.status(400).json({ error: 'Provide the exact current session configuration revision.' });
      return;
    }
    const collect = resolve();
    if (!collect) {
      res.status(503).json({ error: 'Owned session evidence collection is unavailable.' });
      return;
    }
    try {
      const assertCurrent = authorize(req, res);
      assertCurrent();
      const capability = await collect(binding.data, assertCurrent);
      assertCurrent();
      await capability.assertCurrent();
      assertCurrent();
      res.json({ candidate: capability.candidate, activated: false });
    } catch {
      res.status(409).json({ error: 'Current original session evidence could not be verified.' });
    }
  };
}
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
    buildSelection?: SymposiumOwnedBuildSelection;
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
  const build = reviewedSymposiumOwnedBuild(
    config.image ?? TESTED_SYMPOSIUM_NATIVE_BUILD.image,
    host.buildSelection,
  );
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
  const verify = dependencies.verify ?? verifySymposiumProductionGate;
  if (host.buildSelection === undefined) verify(config, candidate, host.physical, invoke);
  else verify(config, candidate, host.physical, invoke, host.buildSelection);
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
