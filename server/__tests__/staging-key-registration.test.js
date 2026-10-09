import { it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import { validateKeyRefusalRegistration } from '../../scripts/lib/staging-cold-plist.mjs';
const root = '/private/stage',
  plan = { releaseRoot: '/private/stage/releases/accepted' },
  node = '/trusted/node';
function plist() {
  const owned = root + '/symposium/service';
  return {
    Label: 'com.mitzo.staging',
    ProgramArguments: [
      node,
      plan.releaseRoot + '/scripts/start-staging-custodian.mjs',
      owned + '/owned-release.json',
      root + '/symposium/settings/staging-registration.json',
      owned + '/staging-operator.json',
      '--canonical',
    ],
    EnvironmentVariables: { NODE_OPTIONS: '', NODE_PATH: '', DOTENV_CONFIG_PATH: '/dev/null' },
    WorkingDirectory: plan.releaseRoot,
    StandardOutPath: owned + '/owner.stdout.log',
    StandardErrorPath: owned + '/owner.stderr.log',
    KeepAlive: false,
    RunAtLoad: false,
    ExitTimeOut: 180,
  };
}
it('requires byte-identical prepared registration and the complete canonical command/environment', () => {
  const p = plist(),
    b = Buffer.from('canonical XML');
  expect(() => validateKeyRefusalRegistration(root, plan, b, b, p, node)).not.toThrow();
  for (const change of [
    (v) => (v.ProgramArguments[1] = '/unreviewed/command'),
    (v) => (v.EnvironmentVariables.NODE_OPTIONS = '--import hidden'),
    (v) => (v.EnvironmentVariables.OPENSHELL_GATEWAY_CONFIG = '/alternate'),
    (v) => (v.KeepAlive = true),
  ]) {
    const changed = plist();
    change(changed);
    expect(() => validateKeyRefusalRegistration(root, plan, b, b, changed, node)).toThrow();
  }
  expect(() =>
    validateKeyRefusalRegistration(root, plan, Buffer.from('current changed'), b, p, node),
  ).toThrow();
});

import { validateLoadedHistoricalJob } from '../../scripts/lib/staging-cold-plist.mjs';
function loaded(p) {
  return `job = {\n program = ${p.ProgramArguments[0]}\n arguments = {\n ${p.ProgramArguments.join('\n ')}\n }\n working directory = ${p.WorkingDirectory}\n stdout path = ${p.StandardOutPath}\n stderr path = ${p.StandardErrorPath}\n environment = {\n OSLogRateLimit => 64\n NODE_PATH => \n NODE_OPTIONS => \n DOTENV_CONFIG_PATH => /dev/null\n XPC_SERVICE_NAME => ${p.Label}\n }\n}`;
}
it('also binds the actual loaded command and environment, including blank loader settings', () => {
  const p = plist(),
    text = loaded(p);
  expect(() => validateLoadedHistoricalJob(text, p)).not.toThrow();
  for (const changed of [
    text.replace('program = ' + node, 'program = /other/node'),
    text.replace(plan.releaseRoot + '/scripts/start-staging-custodian.mjs', '/other/launcher'),
    text.replace('NODE_OPTIONS => ', 'NODE_OPTIONS => --import hidden'),
    text.replace('OSLogRateLimit => 64', 'DYLD_INSERT_LIBRARIES => /unreviewed'),
  ])
    expect(() => validateLoadedHistoricalJob(changed, p)).toThrow();
});
