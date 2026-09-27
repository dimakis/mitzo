import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  CredentialReferenceSchema,
  type CredentialReference,
  type CredentialResolver,
} from './credentials.js';
import {
  PublicationCredentialHttpError,
  type PublicationCredentialHandle,
} from './symposium-sealed-publication-authority.js';

export type PublicationCommandRunner = (
  command: 'gh' | 'git',
  args: readonly string[],
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;
const execute = promisify(execFile);
const commandRunner: PublicationCommandRunner = async (command, args, signal, environment) => {
  const cwd = await mkdtemp(join(tmpdir(), 'mitzo-publication-command-'));
  try {
    return await execute(command, [...args], {
      cwd,
      env: { ...environment, HOME: cwd, GH_CONFIG_DIR: cwd },
      signal,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
interface Entry {
  label: string;
  revision: number;
  reference: CredentialReference;
  handle?: PublicationCredentialHandle;
  cancel?: AbortController;
}
/** Explicit server registration only. No secret or generation survives process restart.
 * Keychain mutation cannot revoke an already dispatched request; provider revocation
 * controls that boundary. Never silently replace a selected credential. */
export class PublicationCredentialCustodian {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly resolver: CredentialResolver,
    private readonly runner: PublicationCommandRunner = commandRunner,
  ) {}
  register(id: string, label: string, reference: CredentialReference) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
      !label.trim() ||
      label.length > 200 ||
      this.entries.has(id)
    )
      throw new Error('Invalid publication credential registration');
    this.entries.set(id, {
      label,
      revision: 1,
      reference: CredentialReferenceSchema.parse(reference),
    });
  }
  list() {
    return [...this.entries].map(([id, e]) => ({
      id,
      label: e.label,
      revision: e.revision,
      selected: Boolean(e.handle),
    }));
  }
  private current(id: string, revision: number) {
    const entry = this.entries.get(id);
    if (!entry || entry.revision !== revision)
      throw new Error('Publication credential revision changed');
    return entry;
  }
  disconnect(id: string, revision: number) {
    const entry = this.current(id, revision);
    entry.cancel?.abort();
    entry.handle = undefined;
    entry.cancel = undefined;
    entry.revision++;
  }
  resolve(id: string, revision: number, generation: string) {
    const entry = this.entries.get(id);
    return entry?.revision === revision && entry.handle?.generation === generation
      ? entry.handle
      : null;
  }
  async select(id: string, revision: number): Promise<PublicationCredentialHandle> {
    const entry = this.current(id, revision);
    if (entry.handle) return entry.handle;
    const secret = await this.resolver.resolve(entry.reference);
    if (!/^[!-~]{1,4096}$/.test(secret))
      throw new Error('Publication credential material is invalid');
    if (this.current(id, revision) !== entry || entry.handle)
      throw new Error('Publication credential selection changed');
    const cancel = new AbortController();
    const assertCurrent = (): true => {
      if (
        cancel.signal.aborted ||
        this.entries.get(id) !== entry ||
        entry.revision !== revision ||
        entry.handle !== handle
      )
        throw new Error('Publication credential is no longer current');
      return true;
    };
    const verify = async () => {
      assertCurrent();
      try {
        if ((await this.resolver.resolve(entry.reference)) !== secret) throw new Error('changed');
      } catch {
        if (entry.handle === handle) this.disconnect(id, revision);
        throw new Error('Publication credential changed or unavailable');
      }
      assertCurrent();
    };
    const handle: PublicationCredentialHandle = Object.freeze({
      connectionId: id,
      revision,
      generation: randomUUID(),
      assertCurrent,
      run: async (command: 'gh' | 'git', args: readonly string[], signal: AbortSignal) => {
        await verify();
        const combined = AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(60_000)]);
        combined.throwIfAborted();
        // Whitelisted environment, no inherited Git configuration, auth, proxies,
        // hooks or user configuration. Secret appears only in child environment.
        const env = {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: '/dev/null',
          GH_CONFIG_DIR: '/dev/null',
          GH_TOKEN: secret,
          GITHUB_TOKEN: secret,
          GH_PROMPT_DISABLED: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '3',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/dev/null',
          GIT_CONFIG_KEY_1: 'credential.helper',
          GIT_CONFIG_VALUE_1: '',
          GIT_CONFIG_KEY_2: 'credential.helper',
          GIT_CONFIG_VALUE_2:
            '!f() { [ "$1" = get ] || exit 0; protocol=; host=; while IFS= read -r line && [ -n "$line" ]; do case "$line" in protocol=*) protocol=${line#protocol=};; host=*) host=${line#host=};; esac; done; [ "$protocol" = https ] && [ "$host" = github.com ] || exit 1; echo username=x-access-token; echo password="$GITHUB_TOKEN"; }; f',
        };
        try {
          if (
            !['gh', 'git'].includes(command) ||
            args.length > 128 ||
            args.some((a) => a.length > 65536 || a.includes('\0'))
          )
            throw new Error('Invalid command');
          const result = await this.runner(command, args, combined, env);
          if (Buffer.byteLength(result.stdout) > 4 * 1024 * 1024 || result.stdout.includes(secret))
            throw new Error('Invalid output');
          await verify();
          combined.throwIfAborted();
          return { stdout: result.stdout };
        } catch (error) {
          if (
            command === 'gh' &&
            !combined.aborted &&
            typeof error === 'object' &&
            error !== null &&
            'stderr' in error &&
            typeof error.stderr === 'string' &&
            /^gh: [^\r\n]* \(HTTP 404\)\r?\n?$/.test(error.stderr)
          ) {
            try {
              await verify();
              combined.throwIfAborted();
            } catch {
              throw new Error('Publication credential command failed');
            }
            // Raw subprocess errors can contain secrets; preserve only the reviewed status.
            throw new PublicationCredentialHttpError(404);
          }
          // Raw subprocess diagnostics may contain the credential; never retain a cause.
          // eslint-disable-next-line preserve-caught-error
          throw new Error('Publication credential command failed');
        }
      },
    });
    entry.cancel = cancel;
    entry.handle = handle;
    return handle;
  }
}
