import Database from 'better-sqlite3';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readCodexStoredAccountKey } from './codex-stored-account.js';
import { AccountProfiles } from './account-profiles.js';
import { codexAccountBinding } from './codex-account.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import { HostCodexLoginReauthorization } from './host-codex-login-reauthorization.js';
import { HostCodexCustodySchema } from './host-codex-custody.js';

export const loginReauthorizationUnavailable = () =>
  Error(
    'Login reauthorization refused. Recheck the selected files, account, reviewed plan and stopped runtime. Original work is retained.',
  );
const Plan = z
  .array(
    z
      .object({
        conversationId: z.string().min(1).max(200),
        operationId: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .passthrough(),
  )
  .min(1)
  .max(128);
export function assertOfflineNativeDatabase(database: string): void {
  // Operator maintenance, not a server startup or process-kill path. Reads are
  // permitted while serving; mutation requires every other process to release
  // the selected private database. An inconclusive host check fails closed.
  const probe = spawnSync('/usr/sbin/lsof', ['-t', '--', database], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (probe.error || ![0, 1].includes(probe.status ?? -1) || probe.stderr.trim())
    throw loginReauthorizationUnavailable();
  const pids = probe.stdout.trim() ? probe.stdout.trim().split(/\s+/) : [];
  if (pids.some((pid) => !/^\d+$/.test(pid) || Number(pid) !== process.pid))
    throw loginReauthorizationUnavailable();
}
/** Plan is read-only, including SQLite schema. Apply is a separately selected
 * offline operation; it has no provider/client, command retry or service restart. */
export async function reauthorizeHostLogins(options: {
  database: string;
  profiles: string;
  conversations: string[];
  approvedPlan?: unknown;
  assertOffline?: () => void;
}) {
  if (
    !isAbsolute(options.database) ||
    !isAbsolute(options.profiles) ||
    realpathSync(options.database) !== options.database ||
    realpathSync(options.profiles) !== options.profiles
  )
    throw loginReauthorizationUnavailable();
  const approved =
    options.approvedPlan === undefined ? undefined : Plan.parse(options.approvedPlan);
  if (
    approved &&
    (approved.length !== options.conversations.length ||
      approved.some((item, index) => item.conversationId !== options.conversations[index]))
  )
    throw loginReauthorizationUnavailable();
  if (
    !options.conversations.length ||
    new Set(options.conversations).size !== options.conversations.length
  )
    throw loginReauthorizationUnavailable();
  const profiles = () => {
    const raw: unknown = JSON.parse(readFileSync(options.profiles, 'utf8'));
    if (!Array.isArray(raw)) throw loginReauthorizationUnavailable();
    return new AccountProfiles(raw, { codexEnabled: true });
  };
  const results: Record<string, unknown>[] = [];
  for (const [index, conversationId] of options.conversations.entries()) {
    const readonly = new Database(options.database, { readonly: true, fileMustExist: true });
    let row: { binding: string; host_custody: string; owner_kind: string } | undefined;
    try {
      row = readonly
        .prepare('SELECT binding,host_custody,owner_kind FROM codex_conversations WHERE id=?')
        .get(conversationId) as typeof row;
    } finally {
      readonly.close();
    }
    if (!row?.host_custody || row.owner_kind !== 'ordinary')
      throw loginReauthorizationUnavailable();
    const selectedProfiles = profiles();
    const routing = selectedProfiles.resumeRouting({
      ...readCodexStoredAccountKey(row.binding),
      accountLabel: 'Stored chat',
    });
    const profile = selectedProfiles.localCodexProfile(routing, true);
    const binding = { ...routing, accountLabel: profile.accountLabel };
    const operator = {
      assertCurrent: () => {
        if (
          !isDeepStrictEqual(
            codexAccountBinding(profiles().localCodexProfile(binding, true)),
            binding,
          )
        )
          throw loginReauthorizationUnavailable();
      },
      assertOffline: options.assertOffline ?? (() => assertOfflineNativeDatabase(options.database)),
    };
    const original = JSON.parse(row.host_custody);
    if (original.login?.refreshProof) {
      // Exact applied receipts are inspectable on rerun without changing them.
      const native = new Database(options.database, { readonly: true, fileMustExist: true });
      try {
        const receipt =
          approved &&
          (native
            .prepare(
              'SELECT result FROM codex_login_reauthorizations WHERE operation_id=? AND conversation_id=?',
            )
            .get(approved[index].operationId, conversationId) as
            { result: string | null } | undefined);
        if (!receipt?.result || !isDeepStrictEqual(JSON.parse(receipt.result), original))
          throw loginReauthorizationUnavailable();
        results.push({
          conversationId,
          operationId: approved![index].operationId,
          status: 'already_completed',
        });
      } finally {
        native.close();
      }
      continue;
    }
    const operation = await HostCodexLoginReauthorization.prepare(
      profile,
      original,
      operator,
      AbortSignal.timeout(30_000),
    );
    if (!approved) {
      results.push({ conversationId, ...operation.summary(), status: 'review_required' });
      continue;
    }
    if (operation.operationId !== approved[index].operationId)
      throw loginReauthorizationUnavailable();
    operator.assertCurrent();
    operator.assertOffline();
    const native = new CodexConversationStore(options.database, {
      maintenance: { assertOffline: operator.assertOffline },
    });
    try {
      results.push({
        conversationId,
        ...native.reauthorizeHostLogin(
          conversationId,
          binding,
          operation,
          approved[index].operationId,
        ),
      });
    } finally {
      native.close();
    }
  }
  return results;
}

const LegacyLoginPlan = z.strictObject({
  version: z.literal(1),
  scanned: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
  plan: z.array(Plan.element).max(10_000),
  blocked: z
    .array(
      z.strictObject({
        conversationId: z.string().min(1).max(200),
        code: z.literal('login_reauthorization_refused'),
      }),
    )
    .max(10_000),
});

/** Inventory all old ordinary host logins without writing SQLite, credentials or
 * custody. One damaged/foreign chat cannot hide the remaining eligible chats. */
export async function planLegacyHostLogins(options: { database: string; profiles: string }) {
  if (!isAbsolute(options.database) || realpathSync(options.database) !== options.database)
    throw loginReauthorizationUnavailable();
  const database = new Database(options.database, { readonly: true, fileMustExist: true });
  const candidates: string[] = [];
  let scanned = 0;
  const blocked: z.infer<typeof LegacyLoginPlan>['blocked'] = [];
  try {
    for (const value of database
      .prepare('SELECT id,host_custody,owner_kind FROM codex_conversations ORDER BY id')
      .iterate()) {
      const row = value as { id: string; host_custody: string | null; owner_kind: string };
      scanned++;
      if (row.owner_kind !== 'ordinary' || !row.host_custody) continue;
      try {
        const custody = HostCodexCustodySchema.parse(JSON.parse(row.host_custody));
        if ('kind' in custody.login || custody.login.refreshProof) continue;
        candidates.push(row.id);
      } catch {
        blocked.push({ conversationId: row.id, code: 'login_reauthorization_refused' });
      }
    }
  } finally {
    database.close();
  }
  // Refuse oversized reports explicitly; never present an incomplete inventory
  // as recovery for all histories or silently select a mutation subset.
  if (candidates.length + blocked.length > 10_000) throw loginReauthorizationUnavailable();
  const plan: z.infer<typeof LegacyLoginPlan>['plan'] = [];
  for (const conversationId of candidates) {
    try {
      const [item] = await reauthorizeHostLogins({ ...options, conversations: [conversationId] });
      plan.push(Plan.element.parse(item));
    } catch {
      blocked.push({ conversationId, code: 'login_reauthorization_refused' });
    }
  }
  return LegacyLoginPlan.parse({
    version: 1,
    scanned,
    eligible: plan.length,
    plan,
    blocked,
  });
}

/** Apply only the reviewed exact list, never a fresh discovery. Existing native
 * journals and custody CAS own crash recovery. Stop at the first refusal and
 * retain successful receipts so an interrupted batch can be retried as reviewed. */
export async function applyLegacyHostLoginPlan(options: {
  database: string;
  profiles: string;
  approvedPlan: unknown;
  assertOffline?: () => void;
}) {
  const report = LegacyLoginPlan.parse(options.approvedPlan);
  if (
    !report.plan.length ||
    new Set(report.plan.map((item) => item.conversationId)).size !== report.plan.length
  )
    throw loginReauthorizationUnavailable();
  const results: Record<string, unknown>[] = [];
  for (const item of report.plan) {
    try {
      const [result] = await reauthorizeHostLogins({
        ...options,
        conversations: [item.conversationId],
        approvedPlan: [item],
      });
      results.push(result);
    } catch {
      return {
        status: 'incomplete' as const,
        results,
        stoppedAt: item.conversationId,
        remaining: report.plan.length - results.length,
        blocked: report.blocked,
      };
    }
  }
  return { status: 'completed' as const, results, remaining: 0, blocked: report.blocked };
}
