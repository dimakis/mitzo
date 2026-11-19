import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  ClaudeSubscriptionCustodySchema,
  type ClaudeSubscriptionCustodySnapshot,
} from '@mitzo/protocol';

const execute = promisify(execFile);
type SignInFailureReason =
  | 'custody_changed'
  | 'identity_mismatch'
  | 'invalid_response'
  | 'native_command_failed'
  | 'cancelled';
type IdentityDiagnostic = {
  identitySource: 'native_status' | 'sdk_account';
  mismatches: ('email' | 'plan' | 'provider' | 'billing')[];
};
export class ClaudeSubscriptionSignInError extends Error {
  readonly code = 'claude_subscription_sign_in_unavailable';
  readonly stage = 'claude_sign_in_verification';
  readonly diagnosticId = randomUUID();
  private readonly identity?: IdentityDiagnostic;
  constructor(
    readonly reason: SignInFailureReason,
    options?: ErrorOptions & { identity?: IdentityDiagnostic },
  ) {
    super(
      'Claude subscription sign-in unavailable; check the configured Claude account on this Mac',
      options,
    );
    this.name = 'ClaudeSubscriptionSignInError';
    this.identity = options?.identity;
  }
  telemetry() {
    return {
      code: this.code,
      stage: this.stage,
      diagnosticId: this.diagnosticId,
      reason: this.reason,
      ...this.identity,
    };
  }
}
const unavailable = () => new ClaudeSubscriptionSignInError('custody_changed');
export function assertClaudeSubscriptionAccount(
  info: import('@anthropic-ai/claude-agent-sdk').AccountInfo,
  env: Readonly<NodeJS.ProcessEnv>,
) {
  // SDK accountInfo() uses display labels; `claude auth status --json` uses IDs.
  // Accept only the known personal plans, never arbitrary matching strings.
  const plan =
    info.subscriptionType === 'Claude Max' || info.subscriptionType === 'max'
      ? 'max'
      : info.subscriptionType === 'Claude Pro' || info.subscriptionType === 'pro'
        ? 'pro'
        : undefined;
  const mismatches: IdentityDiagnostic['mismatches'] = [];
  if (!info.email || info.email.toLowerCase() !== env.MITZO_CLAUDE_EXPECTED_EMAIL?.toLowerCase())
    mismatches.push('email');
  if (!plan || plan !== env.MITZO_CLAUDE_EXPECTED_PLAN) mismatches.push('plan');
  if (info.apiProvider !== 'firstParty') mismatches.push('provider');
  if (info.apiKeySource && info.apiKeySource !== 'none') mismatches.push('billing');
  if (mismatches.length)
    throw new ClaudeSubscriptionSignInError('identity_mismatch', {
      identity: { identitySource: 'sdk_account', mismatches },
    });
}
export function claudeSdkExecutable(): string {
  if (process.platform !== 'darwin') throw unavailable();
  return createRequire(import.meta.url).resolve(
    `@anthropic-ai/claude-agent-sdk-darwin-${process.arch}/claude`,
  );
}
/** This release's installed SDK binary. Only Darwin hosts install one; elsewhere
 * reopen keeps the retained identity, which must still match exactly. */
export const claudeSdkInstallation = {
  executable(): string | undefined {
    return process.platform === 'darwin' ? claudeSdkExecutable() : undefined;
  },
};
/** First identity this process observed for each SDK binary path. Durable chat
 * custody can name an earlier release, so the current release's binary is pinned
 * here instead: every later capture or reopen must observe the same file, and an
 * in-place replacement after first use fails closed. */
const pinnedExecutables = new Map<string, ReturnType<typeof identity>>();
function pinnedExecutable(path: string) {
  const current = identity(path, false);
  const pinned = pinnedExecutables.get(path);
  if (!pinned) pinnedExecutables.set(path, current);
  else if (JSON.stringify(pinned) !== JSON.stringify(current)) throw unavailable();
  return current;
}
function identity(path: string, directory: boolean) {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw unavailable();
  const stat = lstatSync(path, { bigint: true });
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & (directory ? 0o077n : 0o022n)) !== 0n
  )
    throw unavailable();
  return {
    path,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    mode: String(stat.mode),
    ...(directory
      ? {}
      : { size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }),
  };
}
function configured(env: Readonly<NodeJS.ProcessEnv>) {
  if (
    !env.CLAUDE_CONFIG_DIR ||
    !env.MITZO_CLAUDE_EXPECTED_EMAIL ||
    !env.MITZO_CLAUDE_EXPECTED_PLAN ||
    Object.keys(env).some(
      (key) =>
        /^(ANTHROPIC_|GOOGLE_|GCLOUD_|VERTEX_REGION_|CLAUDE_CODE_USE_)/.test(key) && !!env[key],
    ) ||
    env.CLAUDE_CODE_OAUTH_TOKEN
  )
    throw unavailable();
  return {
    email: env.MITZO_CLAUDE_EXPECTED_EMAIL,
    planType: env.MITZO_CLAUDE_EXPECTED_PLAN,
    config: identity(env.CLAUDE_CONFIG_DIR, true),
  };
}
const Status = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal('claude.ai'),
  apiProvider: z.literal('firstParty'),
  email: z.email(),
  subscriptionType: z.enum(['pro', 'max']),
});

/** Native Claude owns OAuth and token refresh. Only account/root/binary identity is retained here. */
export class ClaudeSubscriptionCustody {
  private constructor(private readonly retained: ClaudeSubscriptionCustodySnapshot) {}
  static capture(env: Readonly<NodeJS.ProcessEnv>, executable = claudeSdkExecutable()) {
    const selected = configured(env);
    return new ClaudeSubscriptionCustody(
      ClaudeSubscriptionCustodySchema.parse({
        kind: 'claude-host-login',
        version: 1,
        ...selected,
        executable: pinnedExecutable(realpathSync(executable)),
      }),
    );
  }
  /** The account and config root are durable chat custody. The SDK binary is the
   * current server's execution authority: each deploy installs it under a new
   * release path, so a chat admitted by an earlier release runs this release's
   * own binary, pinned for this process. An in-place change at either the
   * retained or the installed path fails closed. */
  static reopen(
    value: unknown,
    env: Readonly<NodeJS.ProcessEnv>,
    executable: string | undefined = claudeSdkInstallation.executable(),
  ) {
    const retained = ClaudeSubscriptionCustodySchema.parse(value);
    const current = executable === undefined ? undefined : realpathSync(executable);
    const custody = new ClaudeSubscriptionCustody(
      current !== undefined && current !== retained.executable.path
        ? ClaudeSubscriptionCustodySchema.parse({
            ...retained,
            executable: pinnedExecutable(current),
          })
        : retained,
    );
    custody.assertCurrent(env);
    return custody;
  }
  /** Credential identity without the per-release executable attestation. */
  accountIdentity() {
    const { kind, version, email, planType, config } = this.retained;
    return structuredClone({ kind, version, email, planType, config });
  }
  snapshot() {
    return structuredClone(this.retained);
  }
  assertCurrent(env: Readonly<NodeJS.ProcessEnv>) {
    const selected = configured(env);
    if (
      JSON.stringify(selected) !==
        JSON.stringify({
          email: this.retained.email,
          planType: this.retained.planType,
          config: this.retained.config,
        }) ||
      JSON.stringify(identity(this.retained.executable.path, false)) !==
        JSON.stringify(this.retained.executable)
    )
      throw unavailable();
  }
  async verify(env: Readonly<NodeJS.ProcessEnv>, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      this.assertCurrent(env);
      const { stdout } = await execute(
        this.retained.executable.path,
        ['auth', 'status', '--json'],
        {
          env: Object.fromEntries(
            ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR'].flatMap((key) =>
              env[key] === undefined ? [] : [[key, env[key]!]],
            ),
          ),
          signal,
          timeout: 10_000,
          maxBuffer: 32_768,
          encoding: 'utf8',
        },
      );
      const status = Status.parse(JSON.parse(stdout));
      const mismatches: IdentityDiagnostic['mismatches'] = [];
      if (status.email.toLowerCase() !== this.retained.email.toLowerCase())
        mismatches.push('email');
      if (status.subscriptionType !== this.retained.planType) mismatches.push('plan');
      if (mismatches.length)
        throw new ClaudeSubscriptionSignInError('identity_mismatch', {
          identity: { identitySource: 'native_status', mismatches },
        });
      this.assertCurrent(env);
      signal.throwIfAborted();
    } catch (cause) {
      if (signal.aborted) throw new ClaudeSubscriptionSignInError('cancelled', { cause });
      if (cause instanceof ClaudeSubscriptionSignInError) throw cause;
      throw new ClaudeSubscriptionSignInError(
        cause instanceof SyntaxError || cause instanceof z.ZodError
          ? 'invalid_response'
          : 'native_command_failed',
        { cause },
      );
    }
  }
}
