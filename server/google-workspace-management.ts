import { z } from 'zod';
import type { CommandRunner } from './connections-gateway.js';

const provider = 'google-workspace';
const credentialKey = 'GOOGLE_WORKSPACE_CLI_TOKEN';
// Existing Drive consent authorizes Docs, Sheets and Slides. Enforcement in
// the reviewed provider profile permits writing only through the Slides API.
const scopes = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar.readonly',
];
// This safety contract mirrors the reviewed Google profile. Metadata and a
// durable resource version may change; credential and network policy may not.
const ReadonlyEndpoint = z
  .object({
    host: z.enum([
      'www.googleapis.com',
      'docs.googleapis.com',
      'gmail.googleapis.com',
      'sheets.googleapis.com',
    ]),
    port: z.literal(443),
    protocol: z.literal('rest'),
    access: z.literal('read-only'),
    enforcement: z.literal('enforce'),
    tls: z.literal('terminate'),
  })
  .strict();
const SlidesRule = z.union([
  z
    .object({
      allow: z
        .object({ method: z.literal('GET'), path: z.literal('/v1/presentations/**') })
        .strict(),
    })
    .strict(),
  z
    .object({
      allow: z
        .object({
          method: z.literal('POST'),
          path: z.enum(['/v1/presentations', '/v1/presentations/*:batchUpdate']),
        })
        .strict(),
    })
    .strict(),
]);
const ReviewedGoogleProfile = z
  .object({
    id: z.literal('mitzo-google-workspace-spike'),
    resource_version: z.number().int().positive(),
    display_name: z.string().min(1).max(1024),
    description: z.string().min(1).max(4096),
    category: z.literal('data'),
    inference_capable: z.literal(false),
    credentials: z
      .array(
        z
          .object({
            name: z.literal('access_token'),
            description: z.string().min(1).max(4096),
            env_vars: z.tuple([z.literal(credentialKey)]),
            required: z.literal(true),
            auth_style: z.literal('bearer'),
            header_name: z.literal('authorization'),
            query_param: z.literal('').nullable().optional(),
            refresh: z
              .object({
                strategy: z.literal('oauth2_refresh_token'),
                token_url: z.literal('https://oauth2.googleapis.com/token'),
                scopes: z
                  .array(
                    z.enum([
                      'https://www.googleapis.com/auth/drive.readonly',
                      'https://www.googleapis.com/auth/documents.readonly',
                      'https://www.googleapis.com/auth/calendar.readonly',
                      'https://www.googleapis.com/auth/gmail.readonly',
                      'https://www.googleapis.com/auth/spreadsheets.readonly',
                      'https://www.googleapis.com/auth/presentations',
                    ]),
                  )
                  .length(6)
                  .refine((values) => new Set(values).size === 6),
                refresh_before_seconds: z.literal(300),
                max_lifetime_seconds: z.literal(3600),
                material: z
                  .array(
                    z
                      .object({
                        name: z.enum(['client_id', 'client_secret', 'refresh_token']),
                        description: z.string().min(1).max(4096),
                        required: z.literal(true),
                        secret: z.boolean(),
                      })
                      .strict(),
                  )
                  .length(3)
                  .refine(
                    (items) =>
                      new Set(items.map((item) => item.name)).size === 3 &&
                      items.every((item) => item.secret === (item.name !== 'client_id')),
                  ),
              })
              .strict(),
          })
          .strict(),
      )
      .length(1),
    endpoints: z
      .array(
        z.union([
          ReadonlyEndpoint,
          z
            .object({
              host: z.literal('slides.googleapis.com'),
              port: z.literal(443),
              protocol: z.literal('rest'),
              enforcement: z.literal('enforce'),
              tls: z.literal('terminate'),
              rules: z
                .array(SlidesRule)
                .length(3)
                .refine(
                  (rules) =>
                    new Set(rules.map((rule) => `${rule.allow.method}:${rule.allow.path}`)).size ===
                    3,
                ),
            })
            .strict(),
        ]),
      )
      .length(5)
      .refine((endpoints) => new Set(endpoints.map((endpoint) => endpoint.host)).size === 5),
    binaries: z
      .array(z.enum(['/usr/bin/gws', '/usr/bin/node', '/usr/bin/curl', '/usr/local/bin/curl']))
      .length(4)
      .refine((values) => new Set(values).size === 4),
    source: z.string().max(256).optional(),
    scope: z.string().max(256).optional(),
  })
  .strict();
const Credentials = z.object({
  type: z.literal('authorized_user'),
  client_id: z.string().min(1).max(1024),
  client_secret: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(16384),
});
const Token = z.object({
  access_token: z.string().min(1),
  scope: z.string(),
  expires_in: z.number().int().positive(),
});
// Primary Connections gateway JSON contract, verified on the production Mitzo stack.
// The upstream CLI used by owned Vertex gateways has a separate contract.
// See docs/google-workspace-cli-contract.md and openshell-runtime.ts.
const Provider = z.object({
  id: z.string().min(1),
  name: z.string(),
  workspace: z.string(),
  type: z.string(),
  resource_version: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  credential_keys: z.array(z.string()).default([]),
  credential_expires_at_ms: z.record(z.string(), z.number().int()).default({}),
});
const Refresh = z.object({
  credentials: z.array(
    z.object({
      provider_name: z.string(),
      provider_id: z.string(),
      refresh_generation_id: z.string(),
      last_refresh_at_ms: z.number().int(),
      credential_key: z.string(),
      status: z.string(),
      expires_at_ms: z.number().int(),
    }),
  ),
});
export interface GoogleWorkspaceHealth {
  health: 'ready' | 'needs_sign_in' | 'unavailable' | 'not_configured';
  expiresAt: number | null;
  slidesEditing: boolean;
}
export class GoogleWorkspaceManagement {
  private busy = false;
  // Retain unconfirmed updates across requests, including after command failure.
  private pendingRefreshAt: number | undefined;
  constructor(
    private readonly options: {
      run: CommandRunner;
      exportCredentials: (signal: AbortSignal) => Promise<string>;
      request: (url: string, init: RequestInit) => Promise<unknown>;
      workspace?: string;
    },
  ) {}
  private command(args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    return this.options.run([...args, '--workspace', this.options.workspace ?? 'default'], {
      env,
      signal,
      timeoutMs: 30_000,
    });
  }
  private async verifyProvider(signal: AbortSignal) {
    const providers = z
      .array(Provider)
      .parse(JSON.parse(await this.command(['provider', 'list', '-o', 'json'], signal)));
    const matches = providers.filter((item) => item.name === provider);
    const found = matches[0];
    if (
      matches.length !== 1 ||
      found?.type !== 'mitzo-google-workspace-spike' ||
      found.workspace !== (this.options.workspace ?? 'default')
    )
      throw new Error('Google provider is not configured');
    try {
      ReviewedGoogleProfile.parse(
        JSON.parse(
          await this.command(['provider', 'profile', 'export', found.type, '-o', 'json'], signal),
        ),
      );
    } catch {
      throw new Error(
        'Effective Google provider differs from reviewed policy. Restore its reviewed profile and retry.',
      );
    }
    return found;
  }
  private async refreshCredential(signal: AbortSignal) {
    const refresh = Refresh.parse(
      JSON.parse(
        await this.command(['provider', 'refresh', 'status', provider, '-o', 'json'], signal),
      ),
    );
    const matches = refresh.credentials.filter((item) => item.credential_key === credentialKey);
    return matches.length === 1 ? matches[0] : undefined;
  }
  async status(signal: AbortSignal): Promise<GoogleWorkspaceHealth> {
    return this.observeStatus(signal);
  }
  private async observeStatus(signal: AbortSignal): Promise<GoogleWorkspaceHealth> {
    try {
      const before = await this.verifyProvider(signal);
      const current = await this.refreshCredential(signal);
      // Refresh success is recorded before installation. Require a stable
      // provider census and matching installed expiry before advertising readiness.
      const after = await this.verifyProvider(signal);
      const now = Date.now();
      const installed =
        current?.status === 'refreshed' &&
        current.provider_name === provider &&
        current.provider_id === after.id &&
        current.refresh_generation_id.length > 0 &&
        current.last_refresh_at_ms > 0 &&
        current.last_refresh_at_ms <= now &&
        (this.pendingRefreshAt === undefined ||
          current.last_refresh_at_ms > this.pendingRefreshAt) &&
        before.id === after.id &&
        before.resource_version === after.resource_version &&
        before.credential_expires_at_ms[credentialKey] ===
          after.credential_expires_at_ms[credentialKey] &&
        after.credential_keys.includes(credentialKey) &&
        after.credential_expires_at_ms[credentialKey] === current.expires_at_ms;
      if (installed && current.expires_at_ms > now) this.pendingRefreshAt = undefined;
      return {
        health:
          !current ||
          current.status === 'reauthorization_required' ||
          (current.status === 'refreshed' && current.expires_at_ms <= now)
            ? 'needs_sign_in'
            : installed
              ? 'ready'
              : 'unavailable',
        expiresAt: current?.expires_at_ms ?? null,
        // Both observations verified all read boundaries and bounded Slides rules.
        slidesEditing: true,
      };
    } catch {
      return { health: 'unavailable', expiresAt: null, slidesEditing: false };
    }
  }
  private async hostGrant(signal: AbortSignal) {
    try {
      const credentials = Credentials.parse(
        JSON.parse(await this.options.exportCredentials(signal)),
      );
      const body = new URLSearchParams({
        ...credentials,
        grant_type: 'refresh_token',
        scope: scopes.join(' '),
      });
      body.delete('type');
      const token = Token.parse(
        await this.options.request('https://oauth2.googleapis.com/token', {
          method: 'POST',
          body,
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      const returned = new Set(token.scope.split(/\s+/));
      if (returned.size !== scopes.length || scopes.some((scope) => !returned.has(scope)))
        throw new Error('Google scope mismatch');
      const identity = z.object({ user: z.object({ emailAddress: z.string().email() }) }).parse(
        await this.options.request(
          'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
          {
            signal,
            headers: { Authorization: `Bearer ${token.access_token}` },
          },
        ),
      );
      return { credentials, email: identity.user.emailAddress };
    } catch (error) {
      if (error instanceof Error && error.message === 'Google scope mismatch') throw error;
      // Raw OAuth/gws errors can contain credentials; do not retain their cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        'Google sign-in on the Mitzo computer needs attention. Reconnect its gws account and retry.',
      );
    }
  }
  async preview(signal: AbortSignal) {
    await this.verifyProvider(signal);
    const { email } = await this.hostGrant(signal);
    return { email };
  }
  async reconnect(expectedEmail: string, signal: AbortSignal) {
    if (this.busy) throw new Error('A Google update is already running');
    this.busy = true;
    try {
      await this.verifyProvider(signal);
      const { credentials, email } = await this.hostGrant(signal);
      if (email !== expectedEmail)
        throw new Error('Google account changed. Review the account and retry.');
      const previousRefreshAt = (await this.refreshCredential(signal))?.last_refresh_at_ms ?? 0;
      await this.verifyProvider(signal);
      this.pendingRefreshAt = Math.max(this.pendingRefreshAt ?? 0, previousRefreshAt);
      try {
        await this.command(
          [
            'provider',
            'refresh',
            'configure',
            provider,
            '--credential-key',
            credentialKey,
            '--strategy',
            'oauth2-refresh-token',
            '--material',
            `client_id=${credentials.client_id}`,
            '--material',
            `scopes=${scopes.join(' ')}`,
            '--secret-material-env',
            'client_secret=MITZO_GWS_CLIENT_SECRET',
            '--secret-material-env',
            'refresh_token=MITZO_GWS_REFRESH_TOKEN',
            '--credential-expires-at',
            '1',
          ],
          signal,
          {
            MITZO_GWS_CLIENT_SECRET: credentials.client_secret,
            MITZO_GWS_REFRESH_TOKEN: credentials.refresh_token,
          },
        );
      } catch {
        throw new Error(
          'Google recovery could not be confirmed. Check its status before retrying.',
        );
      }
      await this.verifyProvider(signal);
      try {
        await this.command(
          ['provider', 'refresh', 'rotate', provider, '--credential-key', credentialKey],
          signal,
        );
      } catch {
        throw new Error(
          'Google recovery could not be confirmed. Check its status before retrying.',
        );
      }
      return this.observeStatus(signal);
    } finally {
      this.busy = false;
    }
  }
  async rotate(signal: AbortSignal) {
    if (this.busy) throw new Error('A Google update is already running');
    this.busy = true;
    try {
      await this.verifyProvider(signal);
      const previousRefreshAt = (await this.refreshCredential(signal))?.last_refresh_at_ms ?? 0;
      await this.verifyProvider(signal);
      this.pendingRefreshAt = Math.max(this.pendingRefreshAt ?? 0, previousRefreshAt);
      try {
        await this.command(
          ['provider', 'refresh', 'rotate', provider, '--credential-key', credentialKey],
          signal,
        );
      } catch {
        throw new Error('Google refresh could not be confirmed. Check its status before retrying.');
      }
      return this.observeStatus(signal);
    } finally {
      this.busy = false;
    }
  }
}
