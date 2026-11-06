#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  reauthorizeHostLogins,
  loginReauthorizationUnavailable as unavailable,
} from '../server/host-codex-login-recovery-command.js';
export { reauthorizeHostLogins };

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
