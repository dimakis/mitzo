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
    models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()).min(1),
  })
  .strict();

const CodexProfile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    label: z.string().min(1),
    provider: z.literal('openai-codex'),
    credentialRef: z.string().refine(isAbsolute),
    email: z.string().min(1),
    planType: z.string().min(1),
    models: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) }).strict()).min(1),
  })
  .strict();
const Profile = z.discriminatedUnion('provider', [VertexProfile, CodexProfile]);

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
  }

  catalog() {
    return this.profiles
      .filter((p) => p.provider !== 'openai-codex' || this.options.codexEnabled)
      .map(({ id, label, provider, models }) => ({
        id,
        label,
        provider,
        billing: provider === 'openai-codex' ? 'chatgpt-subscription' : 'google-cloud',
        models,
        capabilities: { streaming: true, tools: true, images: provider !== 'openai-codex' },
      }));
  }

  resolve(accountId: string, model?: string): AccountBinding {
    const profile = this.profiles.find((p) => p.id === accountId);
    if (!profile)
      throw new Error('Account is unavailable. Select a configured account for a new task.');
    if (profile.provider === 'openai-codex' && !this.options.codexEnabled)
      throw new Error('Codex execution is not enabled; development acceptance is required');
    if (!model || !profile.models.some((m) => m.id === model)) {
      throw new Error('Model is unavailable for this account. Select a model from its catalog.');
    }
    // Bind routing identity, not presentation or the mutable model allowlist.
    const profileRevision = createHash('sha256')
      .update(
        JSON.stringify(
          profile.provider === 'openai-codex'
            ? [profile.provider, profile.credentialRef, profile.email, profile.planType]
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

  resume(binding: AccountBinding): AccountBinding {
    const current = this.resolve(binding.accountId, binding.model);
    if (current.profileRevision !== binding.profileRevision) {
      throw new Error(
        'Account configuration changed. Start a new task to select the account explicitly.',
      );
    }
    return binding;
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
      model: binding.model,
    };
  }

  sdkEnv(binding: AccountBinding, base: Record<string, string>): Record<string, string> {
    this.resume(binding);
    const profile = this.profiles.find((p) => p.id === binding.accountId)!;
    if (profile.provider === 'openai-codex')
      throw new Error('Codex accounts require the subscription runtime');
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
            process.env.MITZO_CODEX_DEV_ENABLED === '1' && process.env.NODE_ENV !== 'production',
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
  { id: 'claude-opus-4-8', label: 'Opus 4.8', desc: 'Latest Opus' },
  { id: 'claude-opus-4-8:max', label: 'Opus 4.8 Max', desc: 'Max thinking (128k)' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Previous Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', desc: 'Latest Sonnet' },
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
    if (
      selection.accountId &&
      (selection.accountId !== stored.accountId ||
        (selection.model && selection.model !== stored.model))
    ) {
      throw new Error(
        'This task is bound to its original account and model. Start a new task to change them.',
      );
    }
    // Legacy clients attach their global model preference without an account ID.
    // Ignore that hint for bound tasks; only an explicit account selection may request a switch.
    return (profiles ?? loadAccountProfiles()).resume(stored);
  }
  if (!selection.accountId) return undefined;
  if (resuming) throw new Error('Existing legacy tasks cannot change accounts. Start a new task.');
  return (profiles ?? loadAccountProfiles()).resolve(selection.accountId, selection.model);
}
