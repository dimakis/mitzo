import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createConnectionsRuntime } from '../../connections-runtime.js';
import { googleReadFixture } from './google-workspace-read.js';

/** Real production bootstrap and subprocess wiring; only external Google HTTP is substituted. */
export async function googleWorkspaceChatFixture(root: string) {
  const fixture = googleReadFixture();
  const google = join(root, 'google-controller');
  await mkdir(google);
  const cli = join(google, 'gateway');
  const gws = join(google, 'gws');
  await writeFile(
    cli,
    `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]!=='provider')process.exit(65);\nif(a.includes('list'))process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'google-id', name: 'google-workspace', workspace: 'default', type: 'mitzo-google-workspace-spike', resource_version: 9 }]))});\nelse if(a.includes('profile')&&a.includes('export'))process.stdout.write(${JSON.stringify(JSON.stringify(fixture.profile))});\nelse process.exit(65);\n`,
    { mode: 0o755 },
  );
  await writeFile(
    gws,
    `#!/usr/bin/env node\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['auth','export','--unmasked']))process.exit(65);\nprocess.stdout.write(${JSON.stringify(await fixture.exportCredentials())});\n`,
    { mode: 0o755 },
  );
  vi.stubEnv('MITZO_GOOGLE_WORKSPACE_MANAGEMENT_ENABLED', 'true');
  vi.stubEnv('MITZO_GWS_CLI', gws);
  const content = { text: 'Google document content from the approved read' };
  const googleHttp = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (url === 'https://oauth2.googleapis.com/token') {
      if (
        init.method !== 'POST' ||
        !(init.body instanceof URLSearchParams) ||
        init.body.get('refresh_token') !== 'SECRET_REFRESH'
      )
        throw Error('Invalid synthetic OAuth exchange');
      return new Response(
        JSON.stringify({
          access_token: 'SECRET_ACCESS',
          scope:
            'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar.readonly',
          expires_in: 3600,
        }),
      );
    }
    if (
      new Headers(init.headers).get('Authorization') !== 'Bearer SECRET_ACCESS' ||
      init.redirect !== 'error'
    )
      throw Error('Private Google authorization missing');
    if (url === 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')
      return new Response(JSON.stringify({ user: { emailAddress: 'fixture@example.test' } }));
    if (
      parsed.origin === 'https://www.googleapis.com' &&
      parsed.pathname === '/drive/v3/files/fixture-document/export' &&
      parsed.searchParams.get('mimeType') === 'text/plain' &&
      init.method === 'GET'
    )
      return new Response(content.text);
    throw Error('Offline test forbids unrecognized network/model calls');
  });
  vi.stubGlobal('fetch', googleHttp);
  const runtime = createConnectionsRuntime({
    directory: join(google, 'connections'),
    eligibleAccountIds: () => [],
    cli,
    workspace: 'default',
  });
  return {
    runtime,
    googleHttp,
    content,
    contentReads: () =>
      googleHttp.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/export')),
  };
}
