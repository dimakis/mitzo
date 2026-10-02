import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Opaque revision of the credentials/routing actually used by the legacy
 * direct adapters. Only the digest enters the command fingerprint. */
export function deliberateRouteRevision(): string {
  const digest = createHash('sha256');
  const keys = [
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_REGION',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CLOUDSDK_CONFIG',
    'CLOUDSDK_ACTIVE_CONFIG_NAME',
    'CLOUDSDK_CORE_ACCOUNT',
    'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT',
    'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
  ];
  for (const key of keys) digest.update(JSON.stringify([key, process.env[key] ?? null]));
  const read = (path: string) => {
    digest.update(path);
    try {
      const content = readFileSync(path);
      digest.update(content);
      return content.toString();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        // Credential-read failures must not expose paths or credential material.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Provider identity unavailable');
      digest.update('absent');
      return '';
    }
  };
  const root = process.env.CLOUDSDK_CONFIG || join(homedir(), '.config', 'gcloud');
  const active = read(join(root, 'active_config')).trim();
  const name = process.env.CLOUDSDK_ACTIVE_CONFIG_NAME || active || 'default';
  // The local SDK config selects the gcloud principal used by the Gemini adapter.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Provider identity unavailable');
  read(join(root, 'configurations', `config_${name}`));
  read(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(root, 'application_default_credentials.json'),
  );
  for (const key of ['CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE']) {
    if (process.env[key]) read(process.env[key]!);
  }
  return digest.digest('hex');
}
