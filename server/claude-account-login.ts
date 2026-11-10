import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { registerAuthSession, isAuthSessionCurrent, type AuthSession } from './auth.js';
import { createLogger } from './logger.js';
import {
  ClaudeAccountStore,
  ClaudeIdentity,
  ClaudeLoginInput,
  type ClaudeLoginAttempt,
} from './claude-account-store.js';
import {
  createClaudeLoginProcess,
  verifyClaudeLoginIdentity,
  type ClaudeNativeLogin,
} from './claude-login-process.js';

const log = createLogger('claude-account-login');
interface Active {
  controller: AbortController;
  native?: ClaudeNativeLogin;
  timer: ReturnType<typeof setTimeout>;
  unobserve(): void;
  codeSubmitted: boolean;
}
type Options = {
  store: ClaudeAccountStore;
  createLogin?: typeof createClaudeLoginProcess;
  verify?: typeof verifyClaudeLoginIdentity;
  isCurrent?: typeof isAuthSessionCurrent;
  observe?: typeof registerAuthSession;
};
/** One owner-bound pending operation. Status recovery never launches or resubmits native work. */
export class ClaudeAccountLogin {
  private active = new Map<string, Active>();
  private failures = new Map<string, Error>();
  private current: typeof isAuthSessionCurrent;
  private observe: typeof registerAuthSession;
  private createLogin: typeof createClaudeLoginProcess;
  private verify: typeof verifyClaudeLoginIdentity;
  constructor(private options: Options) {
    this.current = options.isCurrent || isAuthSessionCurrent;
    this.observe = options.observe || registerAuthSession;
    this.createLogin = options.createLogin || createClaudeLoginProcess;
    this.verify = options.verify || verifyClaudeLoginIdentity;
    for (const row of options.store.attempts())
      if (['preparing', 'pending', 'verifying'].includes(row.state))
        options.store.update({
          ...row,
          state: 'interrupted',
          errorCode: 'CLAUDE_LOGIN_INTERRUPTED',
        });
  }
  private requireAuth(auth: AuthSession) {
    if (!this.current(auth)) throw Error('Claude sign-in authorization expired or revoked');
  }
  private owned(auth: AuthSession, id: string) {
    this.requireAuth(auth);
    const row = this.options.store.attempt(id);
    if (!row || row.owner !== auth.id) throw Error('Claude sign-in unavailable');
    return row;
  }
  private public(row: ClaudeLoginAttempt) {
    const active = this.active.get(row.requestId);
    return {
      requestId: row.requestId,
      accountId: row.accountId,
      label: row.label,
      state: row.state,
      expiresAt: row.expiresAt,
      errorCode: row.errorCode,
      diagnosticId: row.diagnosticId,
      ...(row.state === 'pending' && active?.native ? { url: active.native.url } : {}),
    };
  }
  status(auth: AuthSession, id: string) {
    return this.public(this.owned(auth, id));
  }
  list(auth: AuthSession) {
    this.requireAuth(auth);
    return {
      enabled: true,
      accounts: this.options.store.accounts(),
      attempts: this.options.store
        .attempts()
        .filter((row) => row.owner === auth.id)
        .slice(-20)
        .map((row) => this.public(row)),
    };
  }
  async start(auth: AuthSession, input: z.input<typeof ClaudeLoginInput>) {
    this.requireAuth(auth);
    const row = this.options.store.reserve(
      auth.id,
      Math.min(auth.expiresAt, Date.now() + 10 * 60_000),
      input,
    );
    if (row.state !== 'preparing' || this.active.has(row.requestId)) return this.public(row);
    const controller = new AbortController();
    const active: Active = {
      controller,
      codeSubmitted: false,
      unobserve: () => undefined,
      timer: setTimeout(
        () => {
          void this.stop(row, 'cancelled', 'CLAUDE_LOGIN_EXPIRED');
        },
        Math.max(0, row.expiresAt - Date.now()),
      ),
    };
    active.timer.unref();
    this.active.set(row.requestId, active);
    active.unobserve = this.observe(auth, () => {
      void this.stop(row, 'cancelled', 'CLAUDE_LOGIN_AUTH_REVOKED');
    });
    try {
      active.native = await this.createLogin(
        this.options.store.config(row.accountId),
        controller.signal,
      );
      if (controller.signal.aborted || !this.current(auth)) {
        await active.native.cancel();
        return this.public(this.options.store.attempt(row.requestId)!);
      }
      this.options.store.assertConfig(row);
      this.options.store.update({ ...row, state: 'pending' });
      void active.native.completion
        .then(async (result) => {
          if (controller.signal.aborted) return;
          if (!result.ok) return this.failed(row, result.cause, 'CLAUDE_LOGIN_PROCESS_FAILED');
          try {
            this.requireAuth(auth);
            this.options.store.assertConfig(row);
            this.options.store.update({ ...row, state: 'verifying' });
            const identity = ClaudeIdentity.parse(
              await this.verify(this.options.store.config(row.accountId), controller.signal),
            );
            this.requireAuth(auth);
            controller.signal.throwIfAborted();
            this.options.store.connected(row, identity);
          } catch (cause) {
            if (!controller.signal.aborted)
              await this.failed(row, cause, 'CLAUDE_LOGIN_VERIFICATION_FAILED');
          } finally {
            this.cleanup(row.requestId);
          }
        })
        .catch((cause: unknown) => this.failed(row, cause, 'CLAUDE_LOGIN_RECOVERY_REQUIRED'));
      return this.public(this.options.store.attempt(row.requestId)!);
    } catch (cause) {
      if (!controller.signal.aborted) await this.failed(row, cause, 'CLAUDE_LOGIN_START_FAILED');
      return this.public(this.options.store.attempt(row.requestId)!);
    }
  }
  async submit(auth: AuthSession, id: string, code: string) {
    const row = this.owned(auth, id),
      active = this.active.get(id);
    if (
      row.state !== 'pending' ||
      !active?.native ||
      active.codeSubmitted ||
      Date.now() >= row.expiresAt
    )
      throw Error('Check Claude sign-in status before submitting another code');
    const parsed = /^([^#\r\n]+)#([^#\r\n]+)$/.exec(code.trim());
    const expected = new URL(active.native.url).searchParams.get('state') || '';
    if (
      !parsed ||
      Buffer.byteLength(parsed[2]) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(parsed[2]), Buffer.from(expected))
    )
      throw Error('Copy the complete code from this sign-in page');
    active.codeSubmitted = true;
    this.options.store.assertConfig(row);
    this.options.store.update({ ...row, state: 'verifying' });
    try {
      await active.native.submit(code.trim());
    } catch (cause) {
      await this.failed(row, cause, 'CLAUDE_LOGIN_CODE_UNCONFIRMED');
    }
    return this.status(auth, id);
  }
  async cancel(auth: AuthSession, id: string) {
    const row = this.owned(auth, id);
    await this.stop(row, 'cancelled', null);
    return this.status(auth, id);
  }
  private async stop(row: ClaudeLoginAttempt, state: 'cancelled', code: string | null) {
    const active = this.active.get(row.requestId);
    if (!active) return;
    // Commit cancellation before awaiting native shutdown; late success cannot publish an account.
    try {
      this.options.store.update({ ...row, state, errorCode: code });
      active.controller.abort();
      await active.native?.cancel();
    } catch (cause) {
      await this.failed(row, cause, 'CLAUDE_LOGIN_CANCELLATION_UNCONFIRMED');
    } finally {
      this.cleanup(row.requestId);
    }
  }
  private async failed(row: ClaudeLoginAttempt, cause: unknown, errorCode: string) {
    const diagnosticId = randomUUID();
    // Retain the cause internally; log only sanitized stage/code/operation correlation.
    const failure = new Error('Claude account sign-in failed', { cause });
    this.failures.set(row.requestId, failure);
    log.error(failure.message, {
      stage: 'claude_account_login',
      code: errorCode,
      requestId: row.requestId,
      diagnosticId,
    });
    try {
      this.options.store.update({ ...row, state: 'failed', errorCode, diagnosticId });
    } catch (journalCause) {
      log.error('Claude sign-in journal update failed', {
        stage: 'claude_login_journal',
        code: 'CLAUDE_LOGIN_JOURNAL_FAILED',
        requestId: row.requestId,
        diagnosticId,
        causeType: journalCause instanceof Error ? journalCause.name : 'unknown',
      });
    }
    const active = this.active.get(row.requestId);
    active?.controller.abort();
    try {
      await active?.native?.cancel();
    } catch (cleanupCause) {
      log.error('Claude login child cleanup unconfirmed', {
        stage: 'claude_login_cleanup',
        code: 'CLAUDE_LOGIN_CHILD_UNCONFIRMED',
        requestId: row.requestId,
        diagnosticId,
        causeType: cleanupCause instanceof Error ? cleanupCause.name : 'unknown',
      });
    }
    this.cleanup(row.requestId);
  }
  private cleanup(id: string) {
    const active = this.active.get(id);
    if (!active) return;
    clearTimeout(active.timer);
    active.unobserve();
    this.active.delete(id);
  }
  async close() {
    for (const id of [...this.active.keys()]) {
      const row = this.options.store.attempt(id);
      if (row) await this.stop(row, 'cancelled', 'CLAUDE_LOGIN_HOST_STOPPED');
    }
    this.options.store.close();
  }
}
