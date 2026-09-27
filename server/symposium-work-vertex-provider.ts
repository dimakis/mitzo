import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { AccountProfiles } from './account-profiles.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';

export const SymposiumWorkVertexProfile = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().min(1).max(256),
  provider: z.literal('anthropic-vertex'),
  credentialRef: z.string().refine(isAbsolute),
  expectedPrincipal: z.email().max(254),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/),
  region: z.literal('global'),
  models: z
    .array(z.strictObject({ id: z.literal('claude-haiku-4-5@20251001'), label: z.string().min(1) }))
    .length(1),
});
const Adc = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().min(1).max(1024),
  client_secret: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(16384),
  quota_project_id: z.string().optional(),
});
type Material = z.infer<typeof Adc>;
type Profile = z.infer<typeof SymposiumWorkVertexProfile>;
interface Dependencies {
  authenticate?(material: Material): Promise<{ email: string; accessToken: string }>;
  run?: typeof spawnSync;
}
async function authenticate(material: Material) {
  // A single bounded snapshot supplies both identity proof and gateway material.
  // fromJSON does not discover an ambient account or reread the ADC path.
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = auth.fromJSON(material);
  client.transporter.defaults = {
    ...client.transporter.defaults,
    timeout: 15_000,
    retry: false,
    maxRedirects: 0,
  };
  const accessToken = (await client.getAccessToken()).token;
  if (!accessToken || !('getTokenInfo' in client)) throw Error();
  const info = await client.getTokenInfo(accessToken);
  if (!info.email || info.email_verified !== true) throw Error();
  return { email: info.email, accessToken };
}
function snapshot(path: string): Material {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 65536)
      throw Error();
    const bytes = Buffer.alloc(65537);
    let size = 0;
    for (;;) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
      if (size > 65536) throw Error();
    }
    return Adc.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}
/** Startup-only provisioning in a fresh retained gateway. Failure publishes no
 * binding; the existing bootstrap owner shuts down the gateway. Never retry a
 * partial provider operation or adopt an existing provider. */
export async function createSymposiumWorkVertexProvider(
  gateway: OwnedSymposiumGateway,
  input: Profile,
  dependencies: Dependencies = {},
) {
  try {
    const selected = SymposiumWorkVertexProfile.parse(input);
    const { expectedPrincipal, ...profile } = selected;
    new AccountProfiles([profile]);
    gateway.verifyCustody();
    const material = snapshot(profile.credentialRef);
    if (material.quota_project_id && material.quota_project_id !== profile.projectId) throw Error();
    const verified = await (dependencies.authenticate ?? authenticate)(material);
    gateway.verifyCustody();
    if (verified.email !== expectedPrincipal || !verified.accessToken) throw Error();
    const environment = validateOpenShellCliEnvironment(gateway.managementEnvironment);
    const run = dependencies.run ?? spawnSync;
    const invoke = (args: string[], secretEnvironment: Record<string, string> = {}) => {
      gateway.verifyCustody();
      const result = run(
        gateway.cli,
        ['provider', '--gateway', gateway.gateway, '--workspace', gateway.workspace, ...args],
        {
          env: { ...environment, ...secretEnvironment },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1_000_000,
        },
      );
      gateway.verifyCustody();
      if (result.error || result.status !== 0) throw Error();
      return String(result.stdout);
    };
    const provider = `symposium-vertex-${randomBytes(12).toString('hex')}`;
    invoke(
      [
        'create',
        '--name',
        provider,
        '--type',
        'google-vertex-ai',
        '--credential',
        'GOOGLE_VERTEX_AI_TOKEN',
        '--config',
        `VERTEX_AI_PROJECT_ID=${profile.projectId}`,
        '--config',
        `VERTEX_AI_REGION=${profile.region}`,
      ],
      { GOOGLE_VERTEX_AI_TOKEN: verified.accessToken },
    );
    const matches: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let pageToken = '';
    do {
      const page = JSON.parse(
        invoke([
          'list',
          '--output',
          'json',
          '--page-size',
          '100',
          ...(pageToken ? ['--page-token', pageToken] : []),
        ]),
      );
      if (!Array.isArray(page.providers) || typeof page.next_page_token !== 'string') throw Error();
      matches.push(
        ...page.providers.filter((row: Record<string, unknown>) => row.name === provider),
      );
      pageToken = page.next_page_token;
      if (pageToken && seen.has(pageToken)) throw Error();
      seen.add(pageToken);
      if (seen.size > 1000) throw Error();
    } while (pageToken);
    const found = matches[0];
    if (
      matches.length !== 1 ||
      typeof found.id !== 'string' ||
      !found.id ||
      found.type !== 'google-vertex-ai' ||
      found.workspace !== gateway.workspace
    )
      throw Error();
    invoke(
      [
        'refresh',
        'configure',
        provider,
        '--credential-key',
        'GOOGLE_VERTEX_AI_TOKEN',
        '--strategy',
        'oauth2-refresh-token',
        '--secret-material-env',
        'client_id=SYMPOSIUM_VERTEX_CLIENT_ID',
        '--secret-material-env',
        'client_secret=SYMPOSIUM_VERTEX_CLIENT_SECRET',
        '--secret-material-env',
        'refresh_token=SYMPOSIUM_VERTEX_REFRESH_TOKEN',
      ],
      {
        SYMPOSIUM_VERTEX_CLIENT_ID: material.client_id,
        SYMPOSIUM_VERTEX_CLIENT_SECRET: material.client_secret,
        SYMPOSIUM_VERTEX_REFRESH_TOKEN: material.refresh_token,
      },
    );
    gateway.verifyCustody();
    return { ...profile, sandboxProvider: provider, sandboxProviderId: found.id };
  } catch {
    // ADC/auth/process failures can embed secrets or private filesystem paths.
    throw new Error('Vertex provisioning unavailable');
  }
}
