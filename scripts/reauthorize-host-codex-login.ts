#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  reauthorizeHostLogins,
  planLegacyHostLogins,
  applyLegacyHostLoginPlan,
  loginReauthorizationUnavailable as unavailable,
} from '../server/host-codex-login-recovery-command.js';
export { reauthorizeHostLogins };

export function parseLoginRecoveryArguments(args: string[]) {
  let database = '',
    profiles = '',
    allLegacy = false;
  let planFile: string | undefined, applyPlan: string | undefined;
  const conversations: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag !== '--conversation' && seen.has(flag)) throw unavailable();
    seen.add(flag);
    if (flag === '--all-legacy') {
      allLegacy = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw unavailable();
    if (flag === '--database') database = value;
    else if (flag === '--profiles') profiles = value;
    else if (flag === '--conversation') conversations.push(value);
    else if (flag === '--plan-file') planFile = value;
    else if (flag === '--apply-plan') applyPlan = value;
    else throw unavailable();
  }
  if (
    !isAbsolute(database) ||
    !isAbsolute(profiles) ||
    (planFile && applyPlan) ||
    (planFile && !isAbsolute(planFile)) ||
    (applyPlan && !isAbsolute(applyPlan)) ||
    (allLegacy && (conversations.length || applyPlan)) ||
    (!allLegacy && !applyPlan && !conversations.length) ||
    new Set(conversations).size !== conversations.length
  )
    throw unavailable();
  return { database, profiles, conversations, allLegacy, planFile, applyPlan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      process.stdout.write(
        'Plan: node --import tsx scripts/reauthorize-host-codex-login.ts --database ABS_PATH --profiles ABS_PATH (--all-legacy | --conversation ID [--conversation ID]) --plan-file ABS_PATH\nApply only after explicit review and stopping the selected runtime: --database ABS_PATH --profiles ABS_PATH --apply-plan ABS_PATH\nBatch apply uses only the exact reviewed plan, stops on refusal and never rescans or sends messages.\n',
      );
    } else {
      const { database, profiles, conversations, allLegacy, planFile, applyPlan } =
        parseLoginRecoveryArguments(args);
      const approved: unknown = applyPlan ? JSON.parse(readFileSync(applyPlan, 'utf8')) : undefined;
      if (applyPlan && !Array.isArray(approved) && conversations.length) throw unavailable();
      const result = allLegacy
        ? await planLegacyHostLogins({ database, profiles })
        : applyPlan && !Array.isArray(approved)
          ? await applyLegacyHostLoginPlan({ database, profiles, approvedPlan: approved })
          : await reauthorizeHostLogins({
              database,
              profiles,
              conversations: conversations.length
                ? conversations
                : (approved as Array<{ conversationId: string }>).map(
                    (item) => item.conversationId,
                  ),
              approvedPlan: approved,
            });
      const output = JSON.stringify(result, null, 2) + '\n';
      if (planFile) writeFileSync(planFile, output, { mode: 0o600, flag: 'wx' });
      process.stdout.write(output);
      if (!Array.isArray(result) && 'status' in result && result.status === 'incomplete')
        process.exitCode = 1;
    }
  } catch {
    process.stderr.write(unavailable().message + '\n');
    process.exitCode = 1;
  }
}
