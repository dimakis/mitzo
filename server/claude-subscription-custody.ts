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
  constructor(
    readonly reason: SignInFailureReason,
    private readonly options?: ErrorOptions & { identity?: IdentityDiagnostic },
  ) {
    super(
      'Claude subscription sign-in unavailable; check the configured Claude account on this Mac',
      options,
    );
    this.name = 'ClaudeSubscriptionSignInError';
  }
  telemetry() {
    return {
      code: this.code,
      stage: this.stage,
      diagnosticId: this.diagnosticId,
      reason: this.reason,
      ...this.options?.identity,
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
        executable: identity(realpathSync(executable), false),
      }),
    );
  }
  static reopen(value: unknown, env: Readonly<NodeJS.ProcessEnv>) {
    const custody = new ClaudeSubscriptionCustody(ClaudeSubscriptionCustodySchema.parse(value));
    custody.assertCurrent(env);
    return custody;
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
