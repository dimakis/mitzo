import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createLogger } from './logger.js';

const log = createLogger('host-github-credential');

/** Fixed system gh locations; never a user-writable or session-selected path. */
export const HOST_GH_EXECUTABLES = Object.freeze([
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
]);

/** Bootstrap-only variable carrying the host login from the controller to the
 * sandbox worker, which removes it from its own environment before anything
 * else runs and delivers it only inside the target's transferred environment.
 * Keeps the secret out of the on-disk launch policy. */
export const HOST_GITHUB_TOKEN_TRANSFER = 'MITZO_SDK_HOST_GITHUB_TOKEN_TRANSFER';

export interface HostGithubCredential {
  readonly token: string;
  readonly gh: string;
}
export type HostGithubCredentialResolver = () => HostGithubCredential | undefined;

/** Non-secret target environment for native git/gh with the host login.
 * Composes with (never clobbers) an existing GIT_CONFIG_COUNT sequence. The
 * GitHub helper list is reset first so no ambient keychain helper is consulted.
 * Signing is disabled because the owner does not require signed commits and the
 * signing agent is unreachable inside the sandbox. */
export function hostGithubEnvironment(gh: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
  let index = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const out: NodeJS.ProcessEnv = {
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const [key, value] of [
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', `!${gh} auth git-credential`],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ]) {
    out[`GIT_CONFIG_KEY_${index}`] = key;
    out[`GIT_CONFIG_VALUE_${index}`] = value;
    index++;
  }
  out.GIT_CONFIG_COUNT = String(index);
  return out;
}

function hostGhExecutable(): string | undefined {
  for (const candidate of HOST_GH_EXECUTABLES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed installation.
    }
  }
  return undefined;
}

/** Stable, non-secret reasons the host login could not be transferred. */
export type HostGithubCredentialUnavailableCode =
  'gh_unavailable' | 'gh_login_timeout' | 'gh_login_unavailable' | 'gh_token_unusable';

export type HostGithubCredentialInspection =
  | { readonly status: 'available'; readonly credential: HostGithubCredential }
  | { readonly status: 'unavailable'; readonly code: HostGithubCredentialUnavailableCode };

/** Read the host operator's active github.com login, exactly as the host `gh`
 * resolves it (normally the macOS keyring). The controller's own publisher
 * token and config directory are never passed, so gh cannot echo them back.
 * Synchronous because SDK process spawning is; the timeout bounds the block.
 * The value is never logged, cached or written to disk, and gh's stderr is
 * discarded so no upstream text can carry it into a diagnostic. */
export function inspectHostGithubCredential(): HostGithubCredentialInspection {
  const gh = hostGhExecutable();
  if (!gh) return { status: 'unavailable', code: 'gh_unavailable' };
  let output: string;
  try {
    output = execFileSync(gh, ['auth', 'token', '--hostname', 'github.com'], {
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME ?? homedir(),
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ...(process.env.USER ? { USER: process.env.USER } : {}),
        ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
      },
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (error) {
    // Not logged in, locked keychain or a gh failure. Only the errno class is
    // retained; the exception text may echo command output.
    return {
      status: 'unavailable',
      code:
        (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
          ? 'gh_login_timeout'
          : 'gh_login_unavailable',
    };
  }
  const token = output.replace(/\n$/, '');
  return /^[A-Za-z0-9_]{1,255}$/.test(token)
    ? { status: 'available', credential: { token, gh } }
    : { status: 'unavailable', code: 'gh_token_unusable' };
}

let lastReportedUnavailable: HostGithubCredentialUnavailableCode | undefined;

/** Resolver used at agent launch. Absence is an expected optional fallback (the
 * agent then has no native GitHub login), so each distinct reason is reported
 * once rather than on every launch; a later success re-arms reporting. */
export const resolveHostGithubCredential: HostGithubCredentialResolver = () => {
  const result = inspectHostGithubCredential();
  if (result.status === 'available') {
    lastReportedUnavailable = undefined;
    return result.credential;
  }
  if (lastReportedUnavailable !== result.code) {
    lastReportedUnavailable = result.code;
    log.warn(
      'Host GitHub CLI login unavailable; agent commands start without a GitHub credential',
      { stage: 'host_github_credential', code: result.code },
    );
  }
  return undefined;
};

/** Variables for a runtime that sets its own sandboxed command environment
 * (Codex `shell_environment_policy.set`). The token is the only secret; the
 * rest routes Git HTTPS auth through `gh` and disables prompts, matching the
 * Claude sandbox worker's delivery of the same login. */
export function hostGithubCommandEnvironment(
  credential: HostGithubCredential,
): Record<string, string> {
  const out: Record<string, string> = { GH_TOKEN: credential.token };
  for (const [key, value] of Object.entries(hostGithubEnvironment(credential.gh, {})))
    if (value !== undefined) out[key] = value;
  return out;
}
