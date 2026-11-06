#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readCodexStoredAccountKey } from '../server/codex-stored-account.js';
import { AccountProfiles } from '../server/account-profiles.js';
import { codexAccountBinding } from '../server/codex-account.js';
import { CodexConversationStore } from '../server/codex-conversation-store.js';
import { HostCodexLoginReauthorization } from '../server/host-codex-login-reauthorization.js';

const unavailable = () =>
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
    throw unavailable();
  const pids = probe.stdout.trim() ? probe.stdout.trim().split(/\s+/) : [];
  if (pids.some((pid) => !/^\d+$/.test(pid) || Number(pid) !== process.pid)) throw unavailable();
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
    throw unavailable();
  const approved =
    options.approvedPlan === undefined ? undefined : Plan.parse(options.approvedPlan);
  if (
    approved &&
    (approved.length !== options.conversations.length ||
      approved.some((item, index) => item.conversationId !== options.conversations[index]))
  )
    throw unavailable();
  if (
    !options.conversations.length ||
    new Set(options.conversations).size !== options.conversations.length
  )
    throw unavailable();
  const profiles = () => {
    const raw: unknown = JSON.parse(readFileSync(options.profiles, 'utf8'));
    if (!Array.isArray(raw)) throw unavailable();
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
    if (!row?.host_custody || row.owner_kind !== 'ordinary') throw unavailable();
    const routing = profiles().resumeRouting({
      ...readCodexStoredAccountKey(row.binding),
      accountLabel: 'Stored chat',
    });
    const profile = profiles().localCodexProfile(routing, true);
    const binding = { ...routing, accountLabel: profile.accountLabel };
    const operator = {
      assertCurrent: () => {
        if (
          !isDeepStrictEqual(
            codexAccountBinding(profiles().localCodexProfile(binding, true)),
            binding,
          )
        )
          throw unavailable();
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
          throw unavailable();
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
    if (operation.operationId !== approved[index].operationId) throw unavailable();
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      process.stdout.write(
        'Plan: node --import tsx scripts/reauthorize-host-codex-login.ts --database ABS_PATH --profiles ABS_PATH --conversation ID [--conversation ID] --plan-file ABS_PATH\nApply only after explicit review and stopping the selected runtime: use the same arguments plus --apply-plan ABS_PATH\n',
      );
    } else {
      let database = '',
        profiles = '',
        planFile: string | undefined,
        applyPlan: string | undefined;
      const conversations: string[] = [];
      for (let i = 0; i < args.length; i += 2) {
        const value = args[i + 1];
        if (!value) throw unavailable();
        if (args[i] === '--database') database = value;
        else if (args[i] === '--profiles') profiles = value;
        else if (args[i] === '--conversation') conversations.push(value);
        else if (args[i] === '--plan-file') planFile = value;
        else if (args[i] === '--apply-plan') applyPlan = value;
        else throw unavailable();
      }
      if (
        (planFile && applyPlan) ||
        (planFile && !isAbsolute(planFile)) ||
        (applyPlan && !isAbsolute(applyPlan))
      )
        throw unavailable();
      const result = await reauthorizeHostLogins({
        database,
        profiles,
        conversations,
        approvedPlan: applyPlan ? JSON.parse(readFileSync(applyPlan, 'utf8')) : undefined,
      });
      const output = JSON.stringify(result, null, 2) + '\n';
      if (planFile) writeFileSync(planFile, output, { mode: 0o600, flag: 'wx' });
      process.stdout.write(output);
    }
  } catch {
    process.stderr.write(unavailable().message + '\n');
    process.exitCode = 1;
  }
}
