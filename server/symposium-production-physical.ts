import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  validateOpenShellCliEnvironment,
  type OpenShellCliEnvironment,
} from './openshell-cli-environment.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type {
  SymposiumProductionPhysicalProof,
  SymposiumOwnedNativeHostBinding,
} from './symposium-production-gate.js';

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Command = (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;
const command: Command = (executable, args, env) => {
  const result = spawnSync(executable, [...args], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Host physical inspection failed');
  return result.stdout;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid physical inspection record');
  return value as Record<string, unknown>;
}
function one(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Physical inspection is not unique');
  return object(value[0]);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(object(value))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Digest the exported public profile JSON with sorted object keys, preserving arrays. */
export function digestSymposiumPublicProfile(profile: unknown): string {
  return hash(canonical(object(profile)));
}

export interface LocalSymposiumPhysicalOptions {
  cli: string;
  podman: string;
  /** Explicit private CLI state/TLS environment, owned by the host bootstrap. */
  cliEnv: OpenShellCliEnvironment;
  /** Explicit Podman connection environment; never inherited from a request. */
  podmanEnv: NodeJS.ProcessEnv;
  ownedGateway: Pick<
    OwnedSymposiumGateway,
    'gateway' | 'workspace' | 'endpoint' | 'verifyGatewayDriverConfig'
  > &
    Partial<Pick<OwnedSymposiumGateway, 'verifyOwnedNativeHost'>>;
}

/** Every observation comes from local Podman or authenticated public gateway APIs.
 * Image bytes are copied from a never-started disposable container, never hashed
 * by a command executing inside a potentially compromised sandbox.
 */
export class LocalSymposiumProductionPhysicalProof implements SymposiumProductionPhysicalProof {
  constructor(
    private readonly options: LocalSymposiumPhysicalOptions,
    private readonly run: Command = command,
  ) {
    if (!isAbsolute(options.cli) || !isAbsolute(options.podman))
      throw new Error('Physical inspection tools must be absolute');
    validateOpenShellCliEnvironment(options.cliEnv);
  }
  private podman(args: readonly string[]): string {
    return this.run(this.options.podman, args, this.options.podmanEnv);
  }
  private publicCli(args: readonly string[], workspace: string): unknown {
    this.verifyGatewayDriverConfig(this.options.ownedGateway.gateway, workspace, 'podman');
    const env = validateOpenShellCliEnvironment(this.options.cliEnv);
    for (const key of [
      'OPENSHELL_GATEWAY',
      'OPENSHELL_GATEWAY_ENDPOINT',
      'OPENSHELL_GATEWAY_INSECURE',
      'OPENSHELL_WORKSPACE',
    ])
      delete env[key];
    return JSON.parse(
      this.run(
        this.options.cli,
        [
          ...args,
          '--gateway',
          this.options.ownedGateway.gateway,
          '--workspace',
          workspace,
          '--color',
          'never',
        ],
        env,
      ),
    );
  }
  verifyOwnedNativeHost(binding: SymposiumOwnedNativeHostBinding): void {
    if (
      !this.options.ownedGateway.verifyOwnedNativeHost ||
      this.options.cli !== binding.cli ||
      canonical(validateOpenShellCliEnvironment(this.options.cliEnv)) !==
        canonical(binding.cliEnvironment)
    )
      throw new Error('Owned native physical verifier route is unavailable');
    this.options.ownedGateway.verifyOwnedNativeHost(binding);
  }
  verifyNativeArtifacts(
    image: string,
    imageDigest: string,
    artifacts: Readonly<Record<string, string>>,
  ): void {
    if (!Object.keys(artifacts).length) throw new Error('Native artifacts are unavailable');
    for (const [path, digest] of Object.entries(artifacts))
      this.verifyImageAndController(image, imageDigest, path, digest);
  }
  verifyImageAndController(
    image: string,
    imageDigest: string,
    controllerPath: string,
    controllerSha256: string,
  ): void {
    if (
      !image ||
      image.startsWith('-') ||
      !sha256.test(imageDigest) ||
      !sha256.test(controllerSha256) ||
      !isAbsolute(controllerPath) ||
      controllerPath.includes('..')
    )
      throw new Error('Invalid image physical proof request');
    const inspect = one(JSON.parse(this.podman(['image', 'inspect', image])));
    if (
      inspect.Digest !== `sha256:${imageDigest}` ||
      typeof inspect.Id !== 'string' ||
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(inspect.Id)
    )
      throw new Error('Runtime image digest changed');
    const root = mkdtempSync(join(tmpdir(), 'symposium-image-proof-'));
    const name = `symposium-image-proof-${randomUUID()}`;
    let created = false;
    try {
      this.podman([
        'create',
        '--pull=never',
        '--network=none',
        '--name',
        name,
        '--entrypoint',
        '/bin/false',
        inspect.Id,
      ]);
      created = true;
      const path = join(root, 'controller');
      this.podman(['cp', `${name}:${controllerPath}`, path]);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(readFileSync(path)) !== controllerSha256)
        throw new Error('Runtime controller digest changed');
    } finally {
      try {
        if (created) this.podman(['rm', name]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  verifyProviderProfile(name: string, expected: string, workspace: string): void {
    if (!identifier.test(name) || !sha256.test(expected)) throw new Error('Invalid profile proof');
    const profile = object(
      this.publicCli(['profile', 'export', name, '--output', 'json'], workspace),
    );
    if (profile.id !== name || digestSymposiumPublicProfile(profile) !== expected)
      throw new Error('Public provider profile changed');
  }
  verifyProviderInstance(binding: {
    name: string;
    id: string;
    type: string;
    profileName: string;
    profileSha256: string;
    workspace: string;
  }): void {
    if (
      ![binding.name, binding.id, binding.type, binding.profileName].every((value) =>
        identifier.test(value),
      ) ||
      binding.type !== binding.profileName
    )
      throw new Error('Provider type must bind the exact upstream profile ID');
    this.verifyProviderProfile(binding.profileName, binding.profileSha256, binding.workspace);
    const rows: Record<string, unknown>[] = [];
    const tokens = new Set<string>();
    let token = '';
    do {
      const args = ['provider', 'list', '--output', 'json', '--page-size', '100'];
      if (token) args.push('--page-token', token);
      const page = object(this.publicCli(args, binding.workspace));
      if (!Array.isArray(page.providers) || typeof page.next_page_token !== 'string')
        throw new Error('Provider inventory shape is unsupported');
      rows.push(...page.providers.map(object));
      token = page.next_page_token;
      if (tokens.has(token) || tokens.size >= 100)
        throw new Error('Provider inventory pagination is invalid');
      tokens.add(token);
    } while (token);
    const matches = rows.filter((row) => row.name === binding.name || row.id === binding.id);
    if (
      matches.length !== 1 ||
      matches[0].name !== binding.name ||
      matches[0].id !== binding.id ||
      matches[0].type !== binding.type ||
      matches[0].workspace !== binding.workspace
    )
      throw new Error('Live provider binding changed');
  }
  verifyGatewayDriverConfig(gateway: string, workspace: string, driver: 'podman' | 'docker'): void {
    this.options.ownedGateway.verifyGatewayDriverConfig(gateway, workspace, driver);
  }
  verifyArtifactVolume(driver: 'podman' | 'docker', name: string, workspace: string): void {
    this.verifyGatewayDriverConfig(this.options.ownedGateway.gateway, workspace, driver);
    if (!identifier.test(name)) throw new Error('Invalid artifact volume name');
    const volume = one(JSON.parse(this.podman(['volume', 'inspect', name])));
    const labels = object(volume.Labels);
    const options = object(volume.Options);
    const required = [
      'mitzo.symposium.purpose',
      'mitzo.symposium.session',
      'mitzo.symposium.workspace',
      'mitzo.symposium.generation',
      'openshell.ai/sandbox-attachable',
      'openshell.ai/sandbox-attachable-workspace',
    ];
    if (
      volume.Name !== name ||
      volume.Driver !== 'local' ||
      Object.keys(options).length ||
      Object.keys(labels).sort().join() !== required.sort().join() ||
      labels['mitzo.symposium.purpose'] !== 'artifacts' ||
      labels['mitzo.symposium.workspace'] !== workspace ||
      labels['openshell.ai/sandbox-attachable-workspace'] !== workspace ||
      labels['openshell.ai/sandbox-attachable'] !== 'true' ||
      typeof labels['mitzo.symposium.session'] !== 'string' ||
      !identifier.test(labels['mitzo.symposium.session'] as string) ||
      typeof labels['mitzo.symposium.generation'] !== 'string' ||
      !identifier.test(labels['mitzo.symposium.generation'] as string)
    )
      throw new Error('Physical artifact volume admission differs');
  }
}
