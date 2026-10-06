import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { z } from 'zod';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumNativeProfileTools } from './symposium-native-profile-tools.js';
import { GithubPublishingFields, githubPublishingDefinition } from './github-publishing-tool.js';
import { webAccessDefinition, withWebAbort } from './request-web-access.js';
import {
  canonicalApprovalUrl,
  resolveApprovedUrl,
  fetchApprovedUrl,
  type ApprovedUrlTarget,
} from './approved-url-fetch.js';
const WebInput = z.strictObject({
  operation: z.enum(['request_access', 'revoke_access', 'fetch']),
  url: z.string().url().max(4000),
  reason: z.string().trim().min(1).max(1000),
});
const PublishInput = z.strictObject(GithubPublishingFields);
interface Row {
  id: string;
  session_id: string;
  identity: string;
  hash: string;
  payload: string;
  status: string;
  created_at: number;
}
interface Dependencies {
  resolve(url: string): Promise<ApprovedUrlTarget>;
  fetch(url: string, target: ApprovedUrlTarget, signal: AbortSignal): Promise<string>;
}
interface Card {
  kind: 'url' | 'publication';
  seatId: string;
  seatName: string;
  accountId: string;
  model: string;
  input: Record<string, unknown>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Requests are data only. Browser approval can grant bounded reads; publication always uses the existing artifact review/credential flow. */
export class SymposiumAccessRequests {
  private db: Database.Database;
  private pending = new Map<
    string,
    { verify(): void; finish(approved: boolean): void; cancel(): void }
  >();
  constructor(
    path: string,
    private deps: Dependencies = { resolve: resolveApprovedUrl, fetch: fetchApprovedUrl },
  ) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_access_requests (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, identity TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }
  close() {
    for (const request of [...this.pending.values()]) request.cancel();
    this.db.close();
  }
  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM symposium_access_requests WHERE id=?').get(id) as
      Row | undefined;
  }
  list(sessionId: string) {
    const rows = this.db
      .prepare(
        'SELECT * FROM symposium_access_requests WHERE session_id=? ORDER BY created_at DESC LIMIT 50',
      )
      .all(sessionId) as Row[];
    for (const row of rows) {
      if (row.status === 'pending' && !this.pending.has(row.id)) {
        this.db
          .prepare(
            "UPDATE symposium_access_requests SET status='cancelled' WHERE id=? AND status='pending'",
          )
          .run(row.id);
        row.status = 'cancelled';
      }
    }
    return rows.map((row) => ({
      ...(JSON.parse(row.payload) as Card),
      id: row.id,
      hash: row.hash,
      status: row.status,
      createdAt: row.created_at,
    }));
  }
  decide(sessionId: string, id: string, hash: string, approved: boolean) {
    const row = this.row(id);
    const pending = this.pending.get(id);
    if (
      !row ||
      row.session_id !== sessionId ||
      row.hash !== hash ||
      row.status !== 'pending' ||
      !pending
    )
      throw new Error('Access request changed or is no longer active');
    pending.verify();
    const result = this.db
      .prepare(
        "UPDATE symposium_access_requests SET status=? WHERE id=? AND hash=? AND status='pending'",
      )
      .run(approved ? 'approved' : 'denied', id, hash);
    if (result.changes !== 1) throw new Error('Access request changed');
    pending.finish(approved);
  }
  dismiss(sessionId: string, id: string, hash: string) {
    const row = this.row(id);
    if (
      !row ||
      row.session_id !== sessionId ||
      row.hash !== hash ||
      row.status !== 'review_requested'
    )
      throw new Error('Publication request changed');
    this.db
      .prepare(
        "UPDATE symposium_access_requests SET status='dismissed' WHERE id=? AND status='review_requested'",
      )
      .run(id);
  }
  private enqueue(sessionId: string, identity: string, card: Card, status: string) {
    const hash = digest(card);
    const existing = this.db
      .prepare('SELECT * FROM symposium_access_requests WHERE identity=?')
      .get(identity) as Row | undefined;
    if (existing) {
      if (existing.hash !== hash) throw new Error('Conflicting access request identity');
      return { row: existing, created: false };
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO symposium_access_requests VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, identity, hash, JSON.stringify(card), status, Date.now());
    return { row: this.row(id)!, created: true };
  }
  private approve(row: Row, verify: () => void, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.pending.delete(row.id);
      };
      const cancel = () => {
        this.db
          .prepare(
            "UPDATE symposium_access_requests SET status='cancelled' WHERE id=? AND status='pending'",
          )
          .run(row.id);
        cleanup();
        reject(new Error('Access request cancelled'));
      };
      const timer = setTimeout(cancel, 5 * 60 * 1000);
      this.pending.set(row.id, {
        verify,
        finish: (approved) => {
          cleanup();
          resolve(approved);
        },
        cancel,
      });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  }
  createTools(scope: {
    execution: SymposiumSeatExecution;
    workdir: string;
    verifyCurrent(): void;
  }): SymposiumNativeProfileTools {
    const { execution } = scope;
    const account = structuredClone(execution.seat.accountBinding);
    const identity = {
      sessionId: execution.sessionId,
      seatId: execution.seat.id,
      claimToken: execution.claimToken,
      account,
      provenance: structuredClone(execution.provenance),
    };
    const grants = new Map<string, { target: ApprovedUrlTarget; expires: number }>();
    const versions = new Map<string, number>();
    const verify = () => {
      execution.signal.throwIfAborted();
      scope.verifyCurrent();
      if (
        !account ||
        !isDeepStrictEqual(account, execution.seat.accountBinding) ||
        !isDeepStrictEqual(identity.provenance, execution.provenance)
      )
        throw new Error('Seat access identity changed');
    };
    const card = (kind: Card['kind'], input: Card['input']): Card => ({
      kind,
      seatId: execution.seat.id,
      seatName: execution.seat.name,
      accountId: account!.accountId,
      model: account!.model,
      input,
    });
    return {
      tools: [
        webAccessDefinition,
        {
          ...githubPublishingDefinition,
          description:
            'Request artifact review and GitHub publication for this seat. This records a request for the user; only the sealed, reviewed artifact and separately approved publication can reach GitHub.',
        },
      ],
      instructions:
        'Use RequestWebAccess with request_access, the exact URL and reason to ask the user for website read access. Wait for the result, then use fetch. Access lasts 15 minutes within this executing seat attempt and grants credential-free reads only; private addresses and custom ports are shown to the user. Use revoke_access to remove it. Use RequestGithubPublish to ask the user to review the artifact and publish it using Symposium artifact review. A request is not a publication, grant or approval; do not claim a push or PR has happened until the reviewed-artifact publication succeeds. Direct GitHub writes remain unavailable.',
      executeTool: async (name, arguments_, callerSignal, call) => {
        try {
          const signal = AbortSignal.any([execution.signal, callerSignal]);
          signal.throwIfAborted();
          verify();
          if (!call.turnId || !call.callId) throw new Error('Provider call identity unavailable');
          if (name === 'RequestGithubPublish') {
            const input = PublishInput.parse(arguments_);
            const path = posix.resolve(input.repositoryPath);
            if (
              path !== input.repositoryPath ||
              !(path === scope.workdir || path.startsWith(scope.workdir + '/'))
            )
              throw new Error('Repository escapes seat workspace');
            const queued = this.enqueue(
              execution.sessionId,
              digest({ identity, call, name }),
              card('publication', input),
              'review_requested',
            );
            return {
              content: JSON.stringify({
                requestId: queued.row.id,
                status: 'awaiting_artifact_review',
                message:
                  'The user can open artifact review in Symposium, then approve publication of the sealed reviewed artifact. No GitHub write has occurred.',
              }),
              isError: false,
            };
          }
          if (name !== 'RequestWebAccess') throw new Error('Seat host tool unavailable');
          const input = WebInput.parse(arguments_);
          const url = canonicalApprovalUrl(input.url);
          if (input.operation === 'revoke_access') {
            versions.set(url.origin, (versions.get(url.origin) ?? 0) + 1);
            grants.delete(url.origin);
            return { content: 'Website read access revoked', isError: false };
          }
          if (input.operation === 'fetch') {
            const grant = grants.get(url.origin);
            if (!grant || grant.expires <= Date.now()) {
              grants.delete(url.origin);
              return {
                content:
                  'Use request_access to ask the user to approve this origin for this executing seat.',
                isError: true,
              };
            }
            const content = await this.deps.fetch(url.href, grant.target, signal);
            signal.throwIfAborted();
            verify();
            if (grants.get(url.origin) !== grant || grant.expires <= Date.now())
              throw new Error('URL grant changed during read');
            return { content, isError: false };
          }
          const version = (versions.get(url.origin) ?? 0) + 1;
          versions.set(url.origin, version);
          const target = await withWebAbort(
            this.deps.resolve(url.href),
            AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          );
          signal.throwIfAborted();
          verify();
          if (target.origin !== url.origin || !target.addresses.length)
            throw new Error('URL destination unavailable');
          const queued = this.enqueue(
            execution.sessionId,
            digest({ identity, call, name }),
            card('url', {
              ...input,
              url: url.href,
              origin: target.origin,
              resolvedAddresses: target.addresses.map((entry) => entry.address),
              access: 'Credential-free GET reads for 15 minutes within this executing seat attempt',
            }),
            'pending',
          );
          if (!queued.created)
            return {
              content:
                'This access request was already handled; use fetch or make a new request_access call.',
              isError: true,
            };
          const approved = await this.approve(queued.row, verify, signal);
          signal.throwIfAborted();
          verify();
          if (!approved || versions.get(url.origin) !== version)
            return { content: 'Website access declined or changed', isError: true };
          grants.set(url.origin, {
            target: structuredClone(target),
            expires: Date.now() + 15 * 60 * 1000,
          });
          return {
            content: `Read access approved for ${url.origin} in this seat attempt for 15 minutes. Use fetch to read it.`,
            isError: false,
          };
        } catch {
          return {
            content:
              'Seat access request did not complete or its executing claim changed. No direct publication was performed.',
            isError: true,
          };
        }
      },
    };
  }
}
