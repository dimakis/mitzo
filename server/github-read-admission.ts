import type { EventStore } from './event-store.js';
import type { GitHubReadResponse } from './github-read-response.js';

type ReadScope = {
  connectionId: string;
  principalId?: string;
  background: boolean;
  signal: AbortSignal;
  assertCurrent(): void;
  validateResponse?(response: GitHubReadResponse): void;
};

/** Shared HTTP admission for the existing authenticated credential owner. It
 * owns no credentials, timers or database lifetime. Each actual transport call
 * gets a newly minted, durably consumed reservation; retries are new charged I/O. */
export class GitHubReadAdmission {
  constructor(private readonly quota: EventStore['githubReadQuota']) {}

  async read<T extends GitHubReadResponse>(
    endpoint: string,
    scope: ReadScope,
    transport: () => Promise<T>,
  ): Promise<T> {
    scope.signal.throwIfAborted();
    scope.assertCurrent();
    const now = Date.now(),
      requestId = this.quota.requestId(now);
    const identity = endpoint === '/user';
    if (!identity && !/^github:[1-9][0-9]*$/.test(scope.principalId ?? ''))
      throw Error('connection_unavailable');
    const reservation = identity
      ? this.quota.reserveIdentity(requestId, scope.connectionId, now, scope.background)
      : this.quota.reserve({
          requestId,
          principalId: scope.principalId!,
          connectionId: scope.connectionId,
          background: scope.background,
          cost: 1,
          now,
          probe: true,
        });
    this.quota.start(reservation.id, now);
    let outcome: { ok: true; response: T } | { ok: false; failure: unknown };
    try {
      const response = await transport();
      let principalId = identity
        ? 'principalId' in reservation && typeof reservation.principalId === 'string'
          ? reservation.principalId
          : null
        : scope.principalId;
      if (identity && !principalId && (response.retryAfterMs || response.status === 429))
        this.quota.deferIdentity(
          Date.now() + Math.min(response.retryAfterMs || 60000, 86400000),
          Date.now(),
        );
      if (identity && response.status === 200) {
        const id = (response.data as { id?: unknown } | null)?.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
          throw Error('connection_unavailable');
        principalId = `github:${id}`;
        this.quota.attest(reservation.id, principalId);
      }
      // Account for the completed I/O even when authority changed while awaiting
      // it. Authority still fences data delivery and every subsequent dispatch.
      let metadataError: unknown;
      if (principalId) {
        try {
          this.observe(principalId, response);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'quota_delayed') throw error;
          metadataError = error;
        }
      }
      scope.signal.throwIfAborted();
      scope.assertCurrent();
      if (identity && scope.principalId && principalId !== scope.principalId)
        throw Error('connection_unavailable');
      scope.validateResponse?.(response);
      if (metadataError) throw metadataError;
      outcome = { ok: true, response };
    } catch (error) {
      outcome = { ok: false, failure: error };
    }
    // No refund. An ignored abort keeps its in-flight slot until the transport
    // settles or its original expiry; the caller may independently stop waiting.
    try {
      this.quota.finish(reservation.id);
    } catch (cleanupError) {
      if (!outcome.ok)
        throw new AggregateError(
          [outcome.failure, cleanupError],
          'GitHub read failed; quota cleanup also failed',
          // eslint-disable-next-line preserve-caught-error -- The cleanup error is retained in errors; the read failure remains the cause.
          { cause: outcome.failure },
        );
      throw cleanupError;
    }
    if (!outcome.ok) throw outcome.failure;
    return outcome.response;
  }

  private observe(principalId: string, response: GitHubReadResponse) {
    const now = Date.now(),
      h = response.headers;
    const retry = Math.max(response.retryAfterMs ?? 0, response.status === 429 ? 60000 : 0);
    if (retry > 0) this.quota.defer(principalId, now + Math.min(retry, 86400000), now);
    const fields = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
    if (h['x-ratelimit-resource'] !== 'core' || fields.some((key) => !/^\d+$/.test(h[key] ?? ''))) {
      this.quota.defer(principalId, now + 60000, now);
      throw Error('quota_delayed');
    }
    try {
      this.quota.observe(
        principalId,
        {
          limit: Number(h[fields[0]]),
          remaining: Number(h[fields[1]]),
          resetAt: Number(h[fields[2]]) * 1000,
        },
        now,
      );
    } catch (error) {
      // Storage failures retain their actual cause; only invalid upstream
      // metadata is translated into bounded backoff.
      if (!(error instanceof Error) || error.message !== 'invalid_quota_metadata') throw error;
      this.quota.defer(principalId, now + 60000, now);
      throw Error('quota_delayed', { cause: error });
    }
  }
}
