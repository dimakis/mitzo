import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { CredentialReferenceSchema } from './credentials.js';
import { CatalogModel } from './model-catalog.js';
import {
  createOwnedSymposiumHost,
  type OwnedSymposiumHostOptions,
} from './symposium-owned-host.js';
import { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import { createSymposiumWorkApiProvider } from './symposium-work-api-provider.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
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
const Config = z.strictObject({
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
    sandboxNamespace: id,
  }),
  personal: z.strictObject({
    workProfiles: z.array(Work),
    accountId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    selectedModel: z.string().min(1),
    models: z.array(CatalogModel.strict()).min(1),
  }),
  artifacts: z.array(z.strictObject({ sessionId: id, volumeName: id, volumeGeneration: id })),
  providerProfiles: z.array(z.strictObject({ path, sha256: digest })).min(1),
});
export type OwnedSymposiumFileConfig = z.infer<typeof Config>;
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
    return Config.parse(JSON.parse(readFileSync(filename, 'utf8')));
  } catch {
    throw new Error('MITZO_SYMPOSIUM_OWNED_HOST_CONFIG must name a private valid host JSON file');
  }
}
type Dependencies = Pick<OwnedSymposiumHostOptions, 'facts' | 'hostGrants'>;
interface BootstrapTools {
  launch: typeof OwnedSymposiumGateway.launch;
  run: typeof spawnSync;
  provisionWork: typeof createSymposiumWorkApiProvider;
}
const defaults: BootstrapTools = {
  launch: OwnedSymposiumGateway.launch,
  run: spawnSync,
  provisionWork: createSymposiumWorkApiProvider,
};
export async function bootstrapConfiguredSymposiumHost(
  filename: string,
  dependencies: Dependencies,
  tools: BootstrapTools = defaults,
) {
  const config = readOwnedSymposiumHostConfig(filename);
  // Read and pin before launch. Import private immutable copies, avoiding a
  // hash-check / CLI-read race on the operator source files.
  const profiles = config.providerProfiles.map((profile) => {
    const stat = lstatSync(profile.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Provider profile must be a regular file');
    const bytes = readFileSync(profile.path);
    if (createHash('sha256').update(bytes).digest('hex') !== profile.sha256)
      throw new Error('Pinned provider profile digest changed');
    return bytes;
  });
  return createOwnedSymposiumHost({ ...config, ...dependencies }, tools.launch, async (gateway) => {
    const environment = validateOpenShellCliEnvironment(gateway.managementEnvironment);
    const invoke = (args: string[]) => {
      gateway.verifyCustody();
      const result = tools.run(gateway.cli, args, {
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1_000_000,
      });
      gateway.verifyCustody();
      if (result.error || result.status !== 0)
        throw new Error('Owned Symposium workspace/profile setup failed');
    };
    if (gateway.workspace !== 'default')
      invoke(['workspace', '--gateway', gateway.gateway, 'create', '--name', gateway.workspace]);
    for (const [index, bytes] of profiles.entries()) {
      const copy = join(gateway.stateDirectory, `provider-profile-${index}.yaml`);
      writeFileSync(copy, bytes, { mode: 0o400, flag: 'wx' });
      invoke([
        'profile',
        '--gateway',
        gateway.gateway,
        '--workspace',
        gateway.workspace,
        'import',
        '--file',
        copy,
      ]);
    }
    const work = [];
    for (const source of config.personal.workProfiles)
      work.push(await tools.provisionWork(gateway, source));
    return work;
  });
}
