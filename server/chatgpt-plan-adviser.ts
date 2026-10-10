import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { CatalogModel } from './model-catalog.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const opaque = () => randomBytes(32).toString('base64url');
const identitySchema = z.object({ sub: z.string().min(1), email: z.string().email() });
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  refresh_token: z.string().min(1).max(16384),
  id_token: z.string().min(1).max(16384),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(1).max(3600),
  scope: z.string().max(4096),
});
export const PlanAdviserAccountSchema = z
  .object({
    id: z.string().regex(/^chatgpt_plan_[a-f0-9]{64}$/),
    label: z.string().trim().min(1).max(80),
    clientId: z.string().regex(/^oaiapp_[A-Za-z0-9_-]+$/),
    subject: z.string().min(1).max(512),
    email: z.string().email(),
    accessToken: z.string().max(16384),
    refreshToken: z.string().max(16384),
    idToken: z.string().max(16384),
    grantedScopes: z.array(z.string()).max(30),
    expiresAt: z.number().int().positive(),
    state: z.enum(['connected', 'reauth_required', 'disconnected']),
    models: z.array(CatalogModel.strict()).min(1).max(200),
  })
  .strict()
  .superRefine((account, context) => {
    if (
      account.state !== 'disconnected' &&
      (!account.accessToken || !account.refreshToken || !account.idToken)
    )
      context.addIssue({ code: 'custom', message: 'Adviser credentials are incomplete' });
  });
export const PlanAdviserStateSchema = z
  .object({
    hostId: z.string().min(1).max(200),
    accounts: z.array(PlanAdviserAccountSchema).max(30),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.accounts.map((account) => account.id)).size !== state.accounts.length)
      context.addIssue({ code: 'custom', message: 'Duplicate adviser registration' });
  });
export type PlanAdviserState = z.infer<typeof PlanAdviserStateSchema>;
type Account = PlanAdviserState['accounts'][number];
export interface PlanAdviserStore {
  load(): PlanAdviserState;
  save(state: PlanAdviserState): void;
  assertCurrent?(): void;
}
type VerifyIdentity = (
  token: string,
  clientId: string,
  nonce: string | undefined,
  signal: AbortSignal,
) => Promise<{ sub: string; email: string }>;
async function verifyIdToken(
  token: string,
  clientId: string,
  nonce: string | undefined,
  signal: AbortSignal,
) {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: 'error',
    signal,
  });
  const metadata = z
    .object({ issuer: z.literal(issuer), jwks_uri: z.string().url() })
    .parse(await boundedJson(response));
  const jwks = new URL(metadata.jwks_uri);
  if (jwks.origin !== issuer || jwks.username || jwks.password || jwks.hash)
    throw Error('Identity signing-key origin changed');
  const { payload } = await jwtVerify(token, createRemoteJWKSet(jwks), {
    issuer,
    audience: clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'email', 'exp', 'iat', ...(nonce ? ['nonce'] : [])],
  });
  signal.throwIfAborted();
  if (nonce && payload.nonce !== nonce) throw Error('Sign-in nonce changed');
  return identitySchema.parse(payload);
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw Error('ChatGPT account request failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw Error('ChatGPT account response exceeded limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function permitted(scope: string) {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (
    !['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'].every((required) =>
      granted.includes(required),
    )
  )
    throw Error('ChatGPT plan permission is missing');
  return granted;
}
const modelPage = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(200),
        display_name: z.string().min(1).max(200),
        visibility: z.string(),
        supported_reasoning_levels: z
          .array(z.object({ effort: z.string().min(1).max(30) }))
          .optional(),
        default_reasoning_level: z.string().max(30).optional(),
      }),
    )
    .max(200),
});

/** Separate OSS registration and direct inference custody. No CLI, API fallback,
 * terminal reference, sandbox reference or tool dispatcher exists in this service. */
export class ChatGptPlanAdviserAccounts {
  private state: PlanAdviserState;
  private pending?: {
    owner: string;
    redirect: string;
    state: string;
    nonce: string;
    verifier: string;
    expiresAt: number;
    label: string;
    account?: Account;
  };
  private exchange = false;
  private exchangingOwner?: string;
  private generation = 0;
  private refreshes = new Map<string, Promise<Account>>();
  private controllers = new Map<string, AbortController>();
  private readonly fetcher: typeof fetch;
  private readonly verify: VerifyIdentity;
  private readonly now: () => number;
  private closed = false;
  constructor(
    private options: {
      store: PlanAdviserStore;
      fetch?: typeof fetch;
      verifyIdToken?: VerifyIdentity;
      now?: () => number;
    },
  ) {
    this.state = PlanAdviserStateSchema.parse(options.store.load());
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.verify = options.verifyIdToken ?? verifyIdToken;
    this.now = options.now ?? Date.now;
    // A saved row is not live proof. Restore through a serialized signed refresh.
    for (const account of this.state.accounts)
      if (account.state === 'connected') account.expiresAt = 1;
  }
  private persist(next: PlanAdviserState) {
    try {
      this.options.store.save(PlanAdviserStateSchema.parse(next));
      this.state = next;
    } catch {
      this.generation++;
      for (const controller of this.controllers.values()) controller.abort();
      for (const account of this.state.accounts) account.state = 'reauth_required';
      throw Error('Adviser credential persistence could not be confirmed');
    }
  }
  private assertOwnership() {
    if (this.closed) throw Error('Adviser accounts are closed');
    try {
      this.options.store.assertCurrent?.();
    } catch {
      this.closed = true;
      this.generation++;
      for (const controller of this.controllers.values()) controller.abort();
      throw Error('Adviser credential storage ownership changed');
    }
  }
  list() {
    this.assertOwnership();
    return this.state.accounts.map(({ id, label, email, state }) => ({ id, label, email, state }));
  }
  catalog() {
    this.assertOwnership();
    return this.state.accounts
      .filter((account) => account.state === 'connected')
      .map(({ id, label, models }) => ({
        id,
        label,
        provider: 'chatgpt-plan' as const,
        models: structuredClone(models),
      }));
  }
  owns(id: string) {
    return id.startsWith('chatgpt_plan_');
  }
  begin(owner: string, redirect: string, label: string, accountId?: string) {
    this.assertOwnership();
    const uri = new URL(redirect);
    if (
      uri.protocol !== 'http:' ||
      uri.hostname !== '127.0.0.1' ||
      uri.pathname !== '/auth/callback' ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password ||
      !uri.port
    )
      throw Error('A loopback sign-in callback is required');
    if (this.pending || this.exchange || (this.state.accounts.length >= 30 && !accountId))
      throw Error('Adviser sign-in is busy');
    const account = accountId ? this.state.accounts.find((row) => row.id === accountId) : undefined;
    if (accountId && !account) throw Error('Saved adviser account unavailable');
    const pending = {
      owner,
      redirect,
      state: opaque(),
      nonce: opaque(),
      verifier: opaque(),
      expiresAt: this.now() + 600000,
      label: z.string().trim().min(1).max(80).parse(label),
      account,
    };
    this.pending = pending;
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: account?.clientId ?? 'dynamic_agent_client',
      ...(account ? { login_hint: account.email } : { agent_name_hint: 'Mitzo' }),
      ext_agent_host_id: this.state.hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: scopes,
      resource,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    }).toString();
    return url.toString();
  }
  cancel(owner: string) {
    if (this.pending?.owner === owner || this.exchangingOwner === owner) {
      this.pending = undefined;
      this.generation++;
    }
  }
  async complete(owner: string, callback: URL, signal: AbortSignal) {
    const pending = this.pending;
    if (
      !pending ||
      pending.owner !== owner ||
      pending.expiresAt <= this.now() ||
      callback.origin + callback.pathname !== pending.redirect ||
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.get('state') !== pending.state
    )
      throw Error('Invalid or expired adviser sign-in');
    this.pending = undefined;
    this.exchange = true;
    this.exchangingOwner = owner;
    const generation = this.generation;
    const assertCurrent = () => {
      this.assertOwnership();
      signal.throwIfAborted();
      if (this.closed || generation !== this.generation)
        throw Error('Adviser sign-in was cancelled');
    };
    try {
      assertCurrent();
      if (
        callback.searchParams.has('error') ||
        callback.searchParams.getAll('code').length !== 1 ||
        !callback.searchParams.get('code') ||
        callback.searchParams.getAll('client_id').length > 1
      )
        throw Error('Adviser sign-in declined');
      const clientId = pending.account?.clientId ?? callback.searchParams.get('client_id');
      if (
        !clientId ||
        !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) ||
        (callback.searchParams.has('client_id') &&
          callback.searchParams.get('client_id') !== clientId)
      )
        throw Error('Issued adviser registration is missing or changed');
      const tokens = await this.tokens(
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          code: callback.searchParams.get('code')!,
          code_verifier: pending.verifier,
          redirect_uri: pending.redirect,
          resource,
        },
        signal,
      );
      const identity = identitySchema.parse(
        await this.verify(tokens.id_token, clientId, pending.nonce, signal),
      );
      assertCurrent();
      if (pending.account && identity.sub !== pending.account.subject)
        throw Error('Selected adviser identity changed');
      const models = await this.models(tokens.access_token, signal);
      assertCurrent();
      const id =
        'chatgpt_plan_' +
        createHash('sha256')
          .update(JSON.stringify([clientId, identity.sub]))
          .digest('hex');
      const account: Account = {
        id,
        label: pending.account?.label ?? pending.label,
        clientId,
        subject: identity.sub,
        email: identity.email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        grantedScopes: permitted(tokens.scope),
        expiresAt: tokens.receivedAt + tokens.expires_in * 1000,
        models,
        state: 'connected',
      };
      if (!pending.account && this.state.accounts.some((row) => row.id === id))
        throw Error('Choose the existing adviser registration');
      if (pending.account && !this.state.accounts.includes(pending.account))
        throw Error('Selected adviser registration changed');
      this.controllers.get(id)?.abort();
      this.controllers.delete(id);
      this.persist({
        ...this.state,
        accounts: [...this.state.accounts.filter((row) => row.id !== id), account],
      });
      return this.list().find((row) => row.id === id)!;
    } catch {
      throw Error('ChatGPT adviser sign-in did not complete');
    } finally {
      this.exchange = false;
      this.exchangingOwner = undefined;
    }
  }
  private async tokens(form: Record<string, string>, signal: AbortSignal) {
    const tokens = tokenSchema.parse(
      await boundedJson(
        await this.fetcher(`${issuer}/api/accounts/oauth/token`, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form),
        }),
      ),
    );
    permitted(tokens.scope);
    return { ...tokens, receivedAt: this.now() };
  }
  private async models(accessToken: string, signal: AbortSignal) {
    const page = modelPage.parse(
      await boundedJson(
        await this.fetcher(`${resource}/models`, {
          redirect: 'error',
          signal,
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ),
    );
    const models = page.models
      .filter((model) => model.visibility === 'list')
      .map((model) => ({
        id: model.slug,
        label: model.display_name,
        ...(model.supported_reasoning_levels
          ? { reasoningEfforts: model.supported_reasoning_levels.map((level) => level.effort) }
          : {}),
        ...(model.default_reasoning_level &&
        model.supported_reasoning_levels?.some(
          (level) => level.effort === model.default_reasoning_level,
        )
          ? { defaultReasoningEffort: model.default_reasoning_level }
          : {}),
      }));
    if (!models.length || new Set(models.map((model) => model.id)).size !== models.length)
      throw Error('Adviser model catalog unavailable');
    return models;
  }
  private async refresh(account: Account, signal: AbortSignal): Promise<Account> {
    let refreshOwner = account;
    try {
      const tokens = await this.tokens(
        {
          grant_type: 'refresh_token',
          client_id: account.clientId,
          refresh_token: account.refreshToken,
          resource,
        },
        signal,
      );
      const identity = identitySchema.parse(
        await this.verify(tokens.id_token, account.clientId, undefined, signal),
      );
      if (
        identity.sub !== account.subject ||
        this.closed ||
        !this.state.accounts.includes(account) ||
        account.state !== 'connected'
      )
        throw Error('Adviser registration changed');
      signal.throwIfAborted();
      // Persist the rotating pair before model discovery; never reuse an old refresh token.
      const next = {
        ...account,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        grantedScopes: permitted(tokens.scope),
        expiresAt: tokens.receivedAt + tokens.expires_in * 1000,
      };
      this.persist({
        ...this.state,
        accounts: this.state.accounts.map((row) => (row === account ? next : row)),
      });
      refreshOwner = next;
      next.models = await this.models(next.accessToken, signal);
      signal.throwIfAborted();
      if (this.closed || !this.state.accounts.includes(next) || next.state !== 'connected')
        throw Error('Adviser registration changed');
      this.persist(this.state);
      return next;
    } catch {
      const current = this.state.accounts.find((row) => row.id === account.id);
      if (current === refreshOwner && current.state === 'connected') {
        current.state = 'reauth_required';
        this.controllers.get(account.id)?.abort();
        this.persist(this.state);
      }
      throw Error('ChatGPT adviser needs sign-in');
    }
  }
  async ready(id: string, model: string, effort: string | null | undefined, signal: AbortSignal) {
    this.assertOwnership();
    signal.throwIfAborted();
    let account = this.state.accounts.find((row) => row.id === id);
    if (!account || account.state !== 'connected')
      throw Error('ChatGPT adviser account unavailable');
    const validate = () => {
      const selected = account!.models.find((entry) => entry.id === model);
      if (!selected || (effort && !selected.reasoningEfforts?.includes(effort)))
        throw Error('Adviser model or thinking mode unavailable');
    };
    validate();
    let controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.controllers.set(id, controller);
    }
    if (account.expiresAt <= this.now() + 60000) {
      let pending = this.refreshes.get(id);
      if (!pending) {
        pending = this.refresh(
          account,
          AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        );
        this.refreshes.set(id, pending);
        void pending
          .finally(() => {
            if (this.refreshes.get(id) === pending) this.refreshes.delete(id);
          })
          .catch(() => {});
      }
      account = await pending;
    }
    signal.throwIfAborted();
    validate();
    const selected = account;
    const assertCurrent = () => {
      this.assertOwnership();
      signal.throwIfAborted();
      if (
        controller!.signal.aborted ||
        !this.state.accounts.includes(selected) ||
        selected.state !== 'connected' ||
        selected.expiresAt <= this.now()
      )
        throw Error('ChatGPT adviser authorization changed');
    };
    assertCurrent();
    return {
      assertCurrent,
      signal: controller.signal,
      accessToken: () => {
        assertCurrent();
        return selected.accessToken;
      },
    };
  }
  async disconnect(id: string, signal: AbortSignal) {
    const account = this.state.accounts.find((row) => row.id === id);
    if (!account) throw Error('Adviser account unavailable');
    this.generation++;
    this.controllers.get(id)?.abort();
    account.state = 'disconnected';
    this.persist(this.state);
    let revoked = false;
    try {
      const metadata = z
        .object({ issuer: z.literal(issuer), revocation_endpoint: z.string().url() })
        .parse(
          await boundedJson(
            await this.fetcher(`${issuer}/.well-known/openid-configuration`, {
              redirect: 'error',
              signal,
            }),
          ),
        );
      const url = new URL(metadata.revocation_endpoint);
      if (url.origin !== issuer || url.username || url.password || url.hash)
        throw Error('Revocation origin changed');
      const response = await this.fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: account.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: account.clientId,
        }),
      });
      revoked = response.status === 200;
    } catch {
      /* Local access is already closed. Remote confirmation is separately reported. */
    }
    account.accessToken = '';
    account.refreshToken = '';
    account.idToken = '';
    account.grantedScopes = [];
    this.persist(this.state);
    return { revoked };
  }
  async close() {
    this.closed = true;
    this.pending = undefined;
    this.generation++;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.refreshes.values());
  }
}
