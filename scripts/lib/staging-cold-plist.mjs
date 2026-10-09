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
// Historical impossibility proof requires the complete original environment too.
export const validateHistoricalColdPlist = validateRecoveryPlist;

export function validateKeyRefusalRegistration(root, plan, registration, prepared, plist, node) {
  if (!registration.equals(prepared))
    throw Error('Stopped registration differs from the prepared canonical command');
  validateHistoricalColdPlist(root, plan, plist, node);
}
/** launchctl's loaded job must agree with the file, not merely name its path. */
export function validateLoadedHistoricalJob(text, plist) {
  const field = (n) => text.match(new RegExp('^\\s*' + n + ' = (.+)$', 'm'))?.[1]?.trim();
  const block = (n) =>
    text.match(new RegExp('^\\s*' + n + ' = \\{\\n([\\s\\S]*?)^\\s*\\}', 'm'))?.[1];
  const args = block('arguments')
    ?.split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const env = Object.fromEntries(
    (block('environment') ?? '')
      .split('\n')
      .filter((v) => v.includes('=>'))
      .map((v) => {
        const match = v.match(/^\s*([A-Za-z0-9_]+)\s*=>\s*(.*?)\s*$/);
        if (!match) throw Error('Loaded canonical environment is malformed');
        return [match[1], match[2]];
      }),
  );
  const expected = {
    ...plist.EnvironmentVariables,
    OSLogRateLimit: '64',
    XPC_SERVICE_NAME: plist.Label,
  };
  if (
    field('program') !== plist.ProgramArguments[0] ||
    JSON.stringify(args) !== JSON.stringify(plist.ProgramArguments) ||
    field('working directory') !== plist.WorkingDirectory ||
    field('stdout path') !== plist.StandardOutPath ||
    field('stderr path') !== plist.StandardErrorPath ||
    Object.keys(env).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => env[key] !== value)
  )
    throw Error('Loaded canonical command or environment differs from the reviewed registration');
}
