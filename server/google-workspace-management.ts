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
  private async observeStatus(
    signal: AbortSignal,
    previousRefreshAt?: number,
  ): Promise<GoogleWorkspaceHealth> {
    try {
      const before = await this.verifyProvider(signal);
      const current = await this.refreshCredential(signal);
      const profile = z
        .object({
          endpoints: z.array(
            z.object({
              host: z.string(),
              rules: z
                .array(z.object({ allow: z.object({ method: z.string(), path: z.string() }) }))
                .optional(),
            }),
          ),
        })
        .parse(
          JSON.parse(
            await this.command(
              ['provider', 'profile', 'export', 'mitzo-google-workspace-spike', '-o', 'json'],
              signal,
            ),
          ),
        );
      const slides = profile.endpoints.find(
        (endpoint) => endpoint.host === 'slides.googleapis.com',
      );
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
        (previousRefreshAt === undefined || current.last_refresh_at_ms > previousRefreshAt) &&
        before.id === after.id &&
        before.resource_version === after.resource_version &&
        before.credential_expires_at_ms[credentialKey] ===
          after.credential_expires_at_ms[credentialKey] &&
        after.credential_keys.includes(credentialKey) &&
        after.credential_expires_at_ms[credentialKey] === current.expires_at_ms;
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
        slidesEditing: ['/v1/presentations', '/v1/presentations/*:batchUpdate'].every((path) =>
          slides?.rules?.some((rule) => rule.allow.method === 'POST' && rule.allow.path === path),
        ),
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
    const { email } = await this.hostGrant(signal);
    return { email };
  }
  async reconnect(expectedEmail: string, signal: AbortSignal) {
    if (this.busy) throw new Error('A Google update is already running');
    this.busy = true;
    try {
      const { credentials, email } = await this.hostGrant(signal);
      if (email !== expectedEmail)
        throw new Error('Google account changed. Review the account and retry.');
      await this.verifyProvider(signal);
      const previousRefreshAt = (await this.refreshCredential(signal))?.last_refresh_at_ms ?? 0;
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
        await this.command(
          ['provider', 'refresh', 'rotate', provider, '--credential-key', credentialKey],
          signal,
        );
      } catch {
        throw new Error(
          'Google recovery could not be confirmed. Check its status before retrying.',
        );
      }
      return this.observeStatus(signal, previousRefreshAt);
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
      try {
        await this.command(
          ['provider', 'refresh', 'rotate', provider, '--credential-key', credentialKey],
          signal,
        );
      } catch {
        throw new Error('Google refresh could not be confirmed. Check its status before retrying.');
      }
      return this.observeStatus(signal, previousRefreshAt);
    } finally {
      this.busy = false;
    }
  }
}
