import { join } from 'node:path';
import { load } from 'js-yaml';
import { createSymposiumWorkVertexProvider } from './symposium-work-vertex-provider.js';
import { readOwnedSymposiumHostConfig } from './symposium-owned-config-schema.js';
export {
  readOwnedSymposiumHostConfig,
  type OwnedSymposiumFileConfig,
} from './symposium-owned-config-schema.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createOwnedSymposiumHost,
  type OwnedSymposiumHostOptions,
} from './symposium-owned-host.js';
import { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import { createSymposiumWorkApiProvider } from './symposium-work-api-provider.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
type Dependencies = Pick<OwnedSymposiumHostOptions, 'facts' | 'hostGrants'>;
interface BootstrapTools {
  launch: typeof OwnedSymposiumGateway.launch;
  run: typeof spawnSync;
  provisionWork: typeof createSymposiumWorkApiProvider;
  provisionVertex?: typeof createSymposiumWorkVertexProvider;
}
const defaults: BootstrapTools = {
  launch: OwnedSymposiumGateway.launch,
  run: spawnSync,
  provisionWork: createSymposiumWorkApiProvider,
  provisionVertex: createSymposiumWorkVertexProvider,
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
  if (config.personal.workProfiles.some((profile) => profile.provider === 'anthropic-vertex')) {
    try {
      const vertex = profiles.filter((bytes) => {
        const document = load(bytes.toString('utf8')) as { id?: unknown } | undefined;
        return document?.id === 'google-vertex-ai';
      });
      if (
        vertex.length !== 1 ||
        createHash('sha256').update(vertex[0]).digest('hex') !==
          'a1aac4f9e3710bba3aaa32c1787d588de6ec3c422198267077db11f1f1e2039d'
      )
        throw Error();
    } catch {
      throw new Error('Vertex requires exactly one reviewed endpointless provider profile');
    }
  }
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
      work.push(
        source.provider === 'anthropic-vertex'
          ? await (tools.provisionVertex ?? createSymposiumWorkVertexProvider)(gateway, source)
          : await tools.provisionWork(gateway, source),
      );
    return work;
  });
}
