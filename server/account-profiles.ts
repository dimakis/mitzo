import { protectCodexProfileRoots } from './codex-private-path.js';
import { cachedModels, CatalogModel, refreshModels, readCodexModels } from './model-catalog.js';
import { CredentialReferenceSchema } from './credentials.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { CodexAccountProfile } from './codex-account.js';

const VertexProfile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    provider: z.literal('anthropic-vertex'),
    projectId: z.string().min(1),
    region: z.string().min(1),
    credentialRef: z
      .string()
      .refine(isAbsolute, 'Credential reference must be an absolute ADC path'),
    models: z.array(CatalogModel.strict()).min(1),
  })
  .strict();

const CodexProfile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    provider: z.literal('openai-codex'),
    credentialRef: z.string().refine(isAbsolute).optional(),
    email: z.string().min(1),
    planType: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    sandboxProvider: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)
      .optional(),
    sandboxProviderType: z.literal('openai-codex-oauth').optional(),
    sandboxProviderId: z.string().min(1).max(128).optional(),
    sandboxGrantId: z.string().min(1).max(128).optional(),
    models: z.array(CatalogModel.strict()).min(1),
  })
  .superRefine((profile, context) => {
    const brokerFields = [
      profile.sandboxProviderType,
      profile.sandboxProviderId,
      profile.sandboxGrantId,
    ];
    const brokered = brokerFields.some(Boolean);
    if (brokered && (!profile.sandboxProvider || brokerFields.some((value) => !value))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Brokered subscription binding is incomplete',
      });
    }
    if (!profile.credentialRef && !brokered) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Codex profile requires a host login or brokered subscription binding',
      });
    }
    if (profile.credentialRef && brokered) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Codex profile cannot combine a host login with a brokered subscription binding',
      });
    }
  })
  .strict();
const ApiProfile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    provider: z.literal('openai'),
    credentialRef: CredentialReferenceSchema,
    sandboxProvider: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)
      .optional(),
    models: z.array(CatalogModel.strict()).min(1),
  })
  .strict();
const GoogleProfile = VertexProfile.extend({ provider: z.literal('google-vertex') });
const Profile = z.discriminatedUnion('provider', [
  VertexProfile,
  GoogleProfile,
  CodexProfile,
  ApiProfile,
]);

function supportedModels(
  provider: z.infer<typeof Profile>['provider'],
  models: z.infer<typeof CatalogModel>[],
) {
  // API sessions always expose tools. Nano models reject requests that include
  // tool_search, so reject both current and dated aliases before execution.
  return provider === 'openai'
    ? models.filter((model) => !/(?:^|-)nano(?:$|-)/i.test(model.id))
    : models;
}

/** Account configuration is server-owned; invocation adapters remain harness-owned. */
export class AccountProfiles {
  private profiles: z.infer<typeof Profile>[];

  constructor(
    config: unknown,
    private options: { codexEnabled?: boolean } = {},
  ) {
    const parsed = z.array(Profile).safeParse(config);
    if (!parsed.success)
      throw new Error('Invalid account profiles configuration. Check the server profile file.');
    this.profiles = parsed.data;
    if (new Set(this.profiles.map((p) => p.id)).size !== this.profiles.length) {
      throw new Error('Account profile IDs must be unique');
    }
    protectCodexProfileRoots(
      this.profiles.flatMap((profile) =>
        typeof profile.credentialRef === 'string' ? [profile.credentialRef] : [],
      ),
    );
  }

  privateCodexRoots(): string[] {
    return this.profiles.flatMap((profile) =>
      profile.provider === 'openai-codex' && profile.credentialRef ? [profile.credentialRef] : [],
    );
  }

  catalog() {
    return this.profiles
      .filter((p) => p.provider !== 'openai-codex' || this.options.codexEnabled)
      .map((profile) => {
        const { id, label, provider } = profile;
        const discovered = cachedModels(JSON.stringify(profile));
        return {
          id,
          label,
          provider,
          billing:
            provider === 'openai-codex'
              ? 'chatgpt-subscription'
              : provider === 'openai'
                ? 'openai-api'
                : 'google-cloud',
          models: supportedModels(
            provider,
            provider === 'anthropic-vertex'
              ? profile.models
              : (discovered?.models ?? profile.models),
          ),
          modelDiscovery: { updatedAt: discovered?.updatedAt, stale: !!discovered?.error },
          capabilities: {
            streaming: provider !== 'google-vertex',
            tools: true,
            images: provider === 'anthropic-vertex' || provider === 'openai-codex',
          },
        };
      })
      .filter((account) => account.models.length > 0);
  }

  /** Legacy requests use the server's Vertex route, not any other account's models. */
  legacyModels(projectId: string | undefined, region: string, credentialRef: string | undefined) {
    // Ambient ADC can resolve through several sources; do not guess a profile identity.
    if (!projectId || !credentialRef) return undefined;
    const profiles = this.profiles.filter(
      (p) =>
        p.provider === 'anthropic-vertex' &&
        p.projectId === projectId &&
        p.region === region &&
        p.credentialRef === credentialRef,
    );
    if (profiles.length > 1) throw new Error('Ambiguous legacy Vertex account profiles');
    return profiles[0]?.models;
  }

  async refresh(force = false) {
    await Promise.all(
      this.profiles
        .filter((p) => p.provider === 'openai-codex' && this.options.codexEnabled)
        .map((profile) =>
          refreshModels(
            JSON.stringify(profile),
            async () => {
              if (profile.provider === 'openai-codex') {
                if (!profile.credentialRef) return profile.models;
                const { CodexAppServerClient } = await import('./codex-app-server-client.js');
                const { verifyCodexAccount } = await import('./codex-account.js');
                const client = CodexAppServerClient.launch(profile.credentialRef);
                try {
                  await client.initialize();
                  await verifyCodexAccount(client, {
                    accountId: profile.id,
                    accountLabel: profile.label,
                    credentialRef: profile.credentialRef,
                    email: profile.email,
                    planType: profile.planType,
                    workspaceId: profile.workspaceId,
                    sandboxProvider: profile.sandboxProvider,
                    model: profile.models[0].id,
                  });
                  return await readCodexModels(client);
                } finally {
                  client.close();
                }
              }
              return profile.models;
            },
            force,
          ),
        ),
    );
  }

  resolve(accountId: string, model?: string, configured = false): AccountBinding {
    const profile = this.profiles.find((p) => p.id === accountId);
    if (!profile)
      throw new Error('Account is unavailable. Select a configured account for a new task.');
    if (profile.provider === 'openai-codex' && !this.options.codexEnabled)
      throw new Error('Codex execution is not enabled; development acceptance is required');
    const selectableModels = supportedModels(
      profile.provider,
      configured || profile.provider === 'anthropic-vertex'
        ? profile.models
        : (cachedModels(JSON.stringify(profile))?.models ?? profile.models),
    );
    if (!model || !selectableModels.some((m) => m.id === model)) {
      throw new Error('Model is unavailable for this account. Select a model from its catalog.');
    }
    // Bind routing identity, not presentation or the mutable model allowlist.
    const profileRevision = createHash('sha256')
      .update(
        JSON.stringify(
          profile.provider === 'openai-codex'
            ? [
                profile.provider,
                profile.credentialRef,
                profile.email,
                profile.planType,
                profile.workspaceId,
                profile.sandboxProvider,
                profile.sandboxProviderType,
                profile.sandboxProviderId,
                profile.sandboxGrantId,
              ]
            : profile.provider === 'openai'
              ? [profile.provider, profile.credentialRef, profile.sandboxProvider]
              : [profile.provider, profile.projectId, profile.region, profile.credentialRef],
        ),
      )
      .digest('hex');
    return {
      accountId,
      accountLabel: profile.label,
      provider: profile.provider,
      model,
      profileRevision,
    };
  }

  validateModelSelection(
    binding: AccountBinding,
    model: string,
    reasoningEffort?: string | null,
  ): void {
    const current = this.resolve(binding.accountId, model);
    if (
      current.provider !== binding.provider ||
      current.profileRevision !== binding.profileRevision
    )
      throw new Error('Account configuration changed');
    if (!reasoningEffort) return;
    const entry = this.catalog()
      .find((account) => account.id === binding.accountId)
      ?.models.find((candidate) => candidate.id === model);
    if (!entry?.reasoningEfforts?.includes(reasoningEffort))
      throw new Error('Thinking level unavailable for this model');
  }

  resume(binding: AccountBinding): AccountBinding {
    const current = this.resolve(
      binding.accountId,
      binding.model,
      this.profiles.some(
        (p) => p.id === binding.accountId && p.models.some((m) => m.id === binding.model),
      ),
    );
    if (current.profileRevision !== binding.profileRevision) {
      throw new Error(
        'Account configuration changed. Start a new task to select the account explicitly.',
      );
    }
    return binding;
  }

  validateModel(binding: AccountBinding, model: string, reasoningEffort?: string | null): void {
    const entry = this.catalog()
      .find((account) => account.id === binding.accountId)
      ?.models.find((candidate) => candidate.id === model);
    if (reasoningEffort && (!entry || !entry.reasoningEfforts?.includes(reasoningEffort)))
      throw new Error('Thinking level unavailable for this model');
    const current = this.resolve(binding.accountId, model);
    if (
      current.provider !== binding.provider ||
      current.profileRevision !== binding.profileRevision
    )
      throw new Error('Account configuration changed');
  }

  codexProfile(binding: AccountBinding): CodexAccountProfile {
    this.resume(binding);
    const profile = this.profiles.find((p) => p.id === binding.accountId);
    if (!profile || profile.provider !== 'openai-codex') throw new Error('Not a Codex account');
    return {
      accountId: profile.id,
      accountLabel: profile.label,
      credentialRef: profile.credentialRef,
      email: profile.email,
      planType: profile.planType,
      ...(profile.workspaceId ? { workspaceId: profile.workspaceId } : {}),
      ...(profile.sandboxProvider ? { sandboxProvider: profile.sandboxProvider } : {}),
      ...(profile.sandboxProviderType ? { sandboxProviderType: profile.sandboxProviderType } : {}),
      ...(profile.sandboxProviderId ? { sandboxProviderId: profile.sandboxProviderId } : {}),
      ...(profile.sandboxGrantId ? { sandboxGrantId: profile.sandboxGrantId } : {}),
      model: binding.model,
    };
  }

  googleProfile(binding: AccountBinding) {
    this.resume(binding);
    const profile = this.profiles.find((p) => p.id === binding.accountId);
    if (!profile || profile.provider !== 'google-vertex')
      throw new Error('Not a Google Vertex account');
    return {
      projectId: profile.projectId,
      region: profile.region,
      credentialRef: profile.credentialRef,
    };
  }

  apiCredential(binding: AccountBinding) {
    return this.apiProfile(binding).credentialRef;
  }

  apiProfile(binding: AccountBinding) {
    this.resume(binding);
    const profile = this.profiles.find((p) => p.id === binding.accountId);
    if (!profile || profile.provider !== 'openai') throw new Error('Not an OpenAI API account');
    return {
      credentialRef: profile.credentialRef,
      sandboxProvider: profile.sandboxProvider,
    };
  }

  sdkEnv(binding: AccountBinding, base: Record<string, string>): Record<string, string> {
    this.resume(binding);
    const profile = this.profiles.find((p) => p.id === binding.accountId)!;
    if (profile.provider === 'openai-codex')
      throw new Error('Codex accounts require the subscription runtime');
    if (profile.provider === 'openai')
      throw new Error('OpenAI API accounts require their native runtime');
    if (profile.provider === 'google-vertex')
      throw new Error('Google Vertex accounts require their native runtime');
    const env = { ...base };
    // Remove inherited alternate billing/routing controls before setting the chosen profile.
    for (const key of Object.keys(env)) {
      if (
        /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_SKIP_|VERTEX_REGION_)/.test(key) ||
        [
          'CLOUD_ML_REGION',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'GOOGLE_API_KEY',
          'GOOGLE_APPLICATION_CREDENTIALS',
        ].includes(key)
      )
        delete env[key];
    }
    return {
      ...env,
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: profile.projectId,
      CLOUD_ML_REGION: profile.region,
      GOOGLE_APPLICATION_CREDENTIALS: profile.credentialRef,
    };
  }
}

/** A file contains profiles and credential references, never credential values. */
export function loadAccountProfiles(): AccountProfiles {
  if (process.env.MITZO_ACCOUNT_PROFILES_FILE) {
    try {
      return new AccountProfiles(
        JSON.parse(readFileSync(process.env.MITZO_ACCOUNT_PROFILES_FILE, 'utf8')),
        {
          codexEnabled:
            process.env.MITZO_CODEX_ENABLED === '1' ||
            (process.env.MITZO_CODEX_DEV_ENABLED === '1' && process.env.NODE_ENV !== 'production'),
        },
      );
    } catch {
      // Raw parser/schema errors may contain credential material from an invalid profile.
      throw new Error(
        'Cannot load account profiles. Check MITZO_ACCOUNT_PROFILES_FILE on the Mac.',
      );
    }
  }
  // Existing Vertex project configuration supplies a visible, explicitly selected billing
  // profile; catalog presence alone never launches a request. Set CLAUDE_CODE_USE_VERTEX=0 to hide it.
  const projectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  if (!projectId || process.env.CLAUDE_CODE_USE_VERTEX === '0') return new AccountProfiles([]);
  return new AccountProfiles([
    {
      id: 'vertex-default',
      label: 'Vertex AI · Google Cloud billing',
      provider: 'anthropic-vertex',
      projectId,
      region: process.env.CLOUD_ML_REGION || 'us-east5',
      credentialRef:
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        join(homedir(), '.config/gcloud/application_default_credentials.json'),
      models: LEGACY_MODELS.map(({ id, label }) => ({ id, label })),
    },
  ]);
}

export const LEGACY_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Most capable' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', desc: 'Previous Sonnet' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest' },
];

/** Legacy sessions stay on their existing route; explicit bindings cannot be switched. */
export function resolveAccountSelection(
  selection: { accountId?: string; model?: string },
  stored?: AccountBinding | null,
  resuming = false,
  profiles?: AccountProfiles,
): AccountBinding | undefined {
  if (stored) {
    if (stored.profileRevision === 'invalid' && stored.provider === 'unavailable')
      throw new Error(
        'Stored account binding is corrupt. Start a new task or repair its metadata.',
      );
    if (selection.accountId && selection.accountId !== stored.accountId) {
      throw new Error(
        'This task is bound to its original account. Start a new task to change accounts.',
      );
    }
    if (selection.accountId && selection.model) {
      const next = (profiles ?? loadAccountProfiles()).resolve(stored.accountId, selection.model);
      if (next.profileRevision !== stored.profileRevision)
        throw new Error('Account configuration changed');
    }
    // Legacy clients attach their global model preference without an account ID.
    // Ignore that hint for bound tasks; only an explicit account selection may request a switch.
    return (profiles ?? loadAccountProfiles()).resume(stored);
  }
  if (!selection.accountId) return undefined;
  if (resuming) throw new Error('Existing legacy tasks cannot change accounts. Start a new task.');
  return (profiles ?? loadAccountProfiles()).resolve(selection.accountId, selection.model);
}
