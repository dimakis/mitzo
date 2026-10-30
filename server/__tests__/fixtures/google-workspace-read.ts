import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { vi } from 'vitest';
export function googleReadFixture() {
  const profile = load(
    readFileSync(
      new URL(
        '../../../docs/spikes/openshell-codex/google-workspace-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const readRequest = vi.fn(async () => 'Google document content from the approved read');
  const exportCredentials = vi.fn(async () =>
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'client',
      client_secret: 'SECRET_CLIENT',
      refresh_token: 'SECRET_REFRESH',
    }),
  );
  const run = vi.fn(async (args: readonly string[]) =>
    args[1] === 'list'
      ? JSON.stringify([
          {
            id: 'google-id',
            name: 'google-workspace',
            workspace: 'default',
            type: 'mitzo-google-workspace-spike',
            resource_version: 9,
          },
        ])
      : JSON.stringify(profile),
  );
  const request = vi.fn(async (url: string) =>
    url.includes('/token')
      ? {
          access_token: 'SECRET_ACCESS',
          scope:
            'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.readonly',
          expires_in: 3600,
        }
      : { user: { emailAddress: 'fixture@example.test' } },
  );
  return {
    options: { run, exportCredentials, request, readRequest },
    readRequest,
    exportCredentials,
    run,
    request,
    profile,
  };
}
