import { isAbsolute } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { CredentialReferenceSchema } from './credentials.js';
import { CatalogModel } from './model-catalog.js';
import { SymposiumWorkVertexProfile } from './symposium-work-vertex-profile.js';
import { PublicationCredentialRegistrationSchema } from './symposium-publication-registration-schema.js';
import { isPodmanSandboxNamespace } from './symposium-podman-namespace.js';
import { CriterionCheckDefinitionSchema } from './symposium-criterion-receipts.js';
const path = z.string().refine(isAbsolute, 'Absolute path required');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const image = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/);
const Work = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1),
  provider: z.literal('openai'),
  credentialRef: CredentialReferenceSchema,
  models: z.array(CatalogModel.strict()).min(1),
});
export const OwnedSymposiumConfigSchema = z.strictObject({
  criterionChecks: z.array(CriterionCheckDefinitionSchema).max(100).optional(),
  publicationCredentials: z.array(PublicationCredentialRegistrationSchema).max(20).optional(),
  gateway: z.strictObject({
    executable: path,
    executableSha256: digest,
    cliExecutable: path,
    cliSha256: digest,
    stateParent: path,
    systemCaBundle: path,
    gateway: id,
    workspace: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/),
    port: z.number().int().min(1024).max(65535),
    podmanSocket: path,
    network: id,
    workloadImage: image,
    sandboxRuntimeImage: image,
    supervisorImage: image,
    tls: z.strictObject({
      serverCert: path,
      serverKey: path,
      clientCa: path,
      managementCert: path,
      managementKey: path,
    }),
    jwt: z.strictObject({ signingKey: path, publicKey: path, kid: path }),
  }),
  attestationPath: path,
  runtime: z.strictObject({
    policy: path,
    seed: path,
    createDetached: z.boolean(),
    sandboxIdLength: z.number().int().min(8).max(13),
  }),
  podman: z.strictObject({
    executable: path,
    environment: z.strictObject({
      HOME: path,
      PATH: z.string().min(1),
      XDG_CONFIG_HOME: path.optional(),
      CONTAINER_CONNECTION: id.optional(),
    }),
    sandboxNamespace: z.string().refine(isPodmanSandboxNamespace),
  }),
  personal: z.strictObject({
    workProfiles: z.array(z.discriminatedUnion('provider', [Work, SymposiumWorkVertexProfile])),
    accountId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    selectedModel: z.string().min(1),
    models: z.array(CatalogModel.strict()).min(1),
  }),
  artifacts: z.array(z.strictObject({ sessionId: id, volumeName: id, volumeGeneration: id })),
  providerProfiles: z.array(z.strictObject({ path, sha256: digest })).min(1),
});
export type OwnedSymposiumFileConfig = z.infer<typeof OwnedSymposiumConfigSchema>;
/** Private host JSON contains paths, secret-store references and explicit models;
 * it cannot provide credential values, callbacks, arbitrary environment or old provider IDs. */
export function readOwnedSymposiumHostConfig(filename: string): OwnedSymposiumFileConfig {
  try {
    if (!isAbsolute(filename)) throw Error();
    const stat = lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw Error();
    return OwnedSymposiumConfigSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
  } catch {
    throw new Error('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG must name a private valid host JSON file');
  }
}
