import { join } from 'node:path';
export function validateRecoveryPlist(root, plan, plist, node) {
  const owned = join(root, 'symposium/service');
  const expected = {
    Label: 'com.mitzo.staging',
    ProgramArguments: [
      node,
      join(plan.releaseRoot, 'scripts/start-staging-custodian.mjs'),
      join(owned, 'owned-release.json'),
      join(root, 'symposium/settings/staging-registration.json'),
      join(owned, 'staging-operator.json'),
      '--canonical',
    ],
    EnvironmentVariables: { NODE_OPTIONS: '', NODE_PATH: '', DOTENV_CONFIG_PATH: '/dev/null' },
    WorkingDirectory: plan.releaseRoot,
    StandardOutPath: join(owned, 'owner.stdout.log'),
    StandardErrorPath: join(owned, 'owner.stderr.log'),
    KeepAlive: false,
    RunAtLoad: false,
    ExitTimeOut: 180,
  };
  const canonical = (v) =>
    JSON.stringify(v, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  if (canonical(plist) !== canonical(expected))
    throw Error('Prepared canonical recovery service changed');
}
