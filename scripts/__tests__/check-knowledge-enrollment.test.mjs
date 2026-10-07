import process from 'node:process';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture({
  active = true,
  previous = true,
  candidate = true,
  changed = false,
  token = 'candidate-token',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'enrollment-guard-'));
  roots.push(root);
  const current = join(root, 'current');
  const next = join(root, 'next');
  mkdirSync(current);
  mkdirSync(next);
  mkdirSync(join(current, 'scripts'));
  writeFileSync(join(current, 'scripts/start.sh'), '#!/bin/bash\n');
  const config = join(root, 'store.json');
  const other = join(root, 'other.json');
  const publisher = join(root, 'publisher.json');
  writeFileSync(publisher, JSON.stringify({ readTokenEnv: 'PUBLICATION_TOKEN' }));
  writeFileSync(
    config,
    JSON.stringify({
      defaultStore: 'mgmt',
      stores: [
        {
          id: 'mgmt',
          publisherUrl: 'http://localhost:8643',
          publisherConfig: publisher,
          adapter: { releaseCommit: 'a'.repeat(40) },
        },
      ],
    }),
  );
  writeFileSync(
    other,
    JSON.stringify({
      defaultStore: 'other',
      stores: [{ id: 'other', publisherConfig: publisher }],
    }),
  );
  writeFileSync(
    join(current, '.env'),
    `SECRET=never-print-this-secret\nPUBLICATION_TOKEN=active-token\n${previous ? `MITZO_KNOWLEDGE_STORE_CONFIG="${config}"` : ''}\n`,
  );
  writeFileSync(
    join(next, '.env'),
    `SECRET=never-print-this-secret\nPUBLICATION_TOKEN=${token}\n${candidate ? `MITZO_KNOWLEDGE_STORE_CONFIG="${changed ? other : config}"` : ''}\n`,
  );
  const plist = join(root, 'active.plist');
  if (active)
    execFileSync('python3', [
      '-c',
      'import plistlib,sys;plistlib.dump({"WorkingDirectory":sys.argv[2],"ProgramArguments":[sys.argv[2]+"/scripts/start.sh"]},open(sys.argv[1],"wb"))',
      plist,
      current,
    ]);
  return {
    root,
    current,
    next,
    plist,
    config,
    run: (extra = []) =>
      spawnSync(
        process.execPath,
        [
          'scripts/check-knowledge-enrollment.mjs',
          '--candidate-env',
          join(next, '.env'),
          '--active-plist',
          plist,
          ...extra,
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH } },
      ),
  };
}
it.each([{ candidate: false }, { changed: true }])(
  'blocks silent loss or replacement without leaking settings: %j',
  (options) => {
    const f = fixture(options);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('knowledge_enrollment_change_requires_opt_out');
    expect(result.stdout + result.stderr).not.toContain('never-print-this-secret');
    expect(result.stdout + result.stderr).not.toContain(f.root);
  },
);
it('allows the same parsed enrollment', () => expect(fixture().run().status).toBe(0));
it.each([
  { previous: false, candidate: false },
  { active: false, candidate: false },
  { previous: false, candidate: true },
])('keeps unenrolled and first deployments valid: %j', (options) =>
  expect(fixture(options).run().status).toBe(0),
);
it.each([{ candidate: false }, { changed: true }])(
  'allows explicit deliberate disable or change: %j',
  (options) => expect(fixture(options).run(['--allow-knowledge-enrollment-change']).status).toBe(0),
);
it('rejects malformed active metadata even with the change opt-out', () => {
  const f = fixture();
  writeFileSync(f.plist, 'never-print-this-secret');
  const result = f.run(['--allow-knowledge-enrollment-change']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('knowledge_enrollment_metadata_unreadable');
  expect(result.stderr).not.toContain('never-print-this-secret');
});
it('rejects unreadable active configuration safely', () => {
  const f = fixture();
  writeFileSync(f.config, 'never-print-this-secret');
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('knowledge_enrollment_metadata_unreadable');
  expect(result.stderr).not.toContain('never-print-this-secret');
});
it('deployment guard precedes every build, validation and host action', () => {
  const script = execFileSync('cat', ['scripts/deploy.sh'], { encoding: 'utf8' });
  expect(script.indexOf('check-knowledge-enrollment.mjs')).toBeGreaterThan(-1);
  expect(script.indexOf('check-knowledge-enrollment.mjs')).toBeLessThan(
    script.indexOf('npm run build:server'),
  );
});

it.each(['', undefined])(
  'blocks missing/empty publisher credential without exposing values: %j',
  (token) => {
    const f = fixture({ token: token ?? '' });
    if (token === undefined)
      writeFileSync(
        join(f.next, '.env'),
        readFileSync(join(f.next, '.env'), 'utf8').replace(/^PUBLICATION_TOKEN=.*\n/m, ''),
      );
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('knowledge_enrollment_credential_missing');
    expect(result.stderr).not.toContain('active-token');
  },
);
it('allows publisher read token rotation', () =>
  expect(fixture({ token: 'rotated-token' }).run().status).toBe(0));
it('active plist enrollment overrides its unenrolled dotenv', () => {
  const f = fixture({ previous: false, candidate: false });
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;plistlib.dump({"WorkingDirectory":sys.argv[2],"ProgramArguments":[sys.argv[2]+"/scripts/start.sh"],"EnvironmentVariables":{"MITZO_KNOWLEDGE_STORE_CONFIG":sys.argv[3],"PUBLICATION_TOKEN":"private-token"}},open(sys.argv[1],"wb"))',
    f.plist,
    f.current,
    f.config,
  ]);
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('knowledge_enrollment_change_requires_opt_out');
  expect(result.stderr).not.toContain('private-token');
});

it('rejects persisted alternate dotenv loading instead of silently treating it as unenrolled', () => {
  const f = fixture({ previous: false, candidate: false });
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;plistlib.dump({"WorkingDirectory":sys.argv[2],"ProgramArguments":[sys.argv[2]+"/scripts/start.sh"],"EnvironmentVariables":{"DOTENV_CONFIG_PATH":sys.argv[3]}},open(sys.argv[1],"wb"))',
    f.plist,
    f.current,
    join(f.current, 'shared.env'),
  ]);
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('knowledge_enrollment_dotenv_override_unsupported');
  expect(result.stderr).not.toContain(f.root);
});

it.each(['DOTENV_CONFIG_QUIET', 'DOTENV_CONFIG_DEBUG'])(
  'does not block a fresh unenrolled host for harmless %s logging',
  (name) => {
    const f = fixture({ active: false, candidate: false });
    writeFileSync(join(f.next, '.env'), `${name}=true\n`);
    expect(f.run().status).toBe(0);
  },
);

it('blocks active launcher cwd disagreement instead of inspecting the wrong dotenv', () => {
  const f = fixture({ previous: false, candidate: false });
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;plistlib.dump({"WorkingDirectory":sys.argv[2],"ProgramArguments":[sys.argv[3]+"/scripts/start.sh"]},open(sys.argv[1],"wb"))',
    f.plist,
    f.next,
    f.current,
  ]);
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('knowledge_enrollment_launcher_unsupported');
  expect(result.stderr).not.toContain(f.root);
});
it('keeps a missing active dotenv valid as an empty unenrolled environment', () => {
  const f = fixture({ previous: false, candidate: false });
  rmSync(join(f.current, '.env'));
  expect(f.run().status).toBe(0);
});
it.each(['--active-plist', '--candidate-env'])(
  'deployment rejects %s redirection before any host/build action',
  (flag) => {
    const f = fixture({ candidate: false });
    const scripts = join(f.next, 'scripts');
    mkdirSync(scripts);
    copyFileSync('scripts/deploy.sh', join(scripts, 'deploy.sh'));
    copyFileSync(
      'scripts/check-knowledge-enrollment.mjs',
      join(scripts, 'check-knowledge-enrollment.mjs'),
    );
    symlinkSync(join(process.cwd(), 'node_modules'), join(f.next, 'node_modules'));
    const marker = join(f.root, 'actions');
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(scripts, 'assert-deployable.sh'),
      `#!/bin/bash\nprintf assert >> '${marker}'\n`,
    );
    chmodSync(join(scripts, 'assert-deployable.sh'), 0o700);
    writeFileSync(join(bin, 'npm'), `#!/bin/bash\nprintf build >> '${marker}'\nexit 23\n`);
    chmodSync(join(bin, 'npm'), 0o700);
    const home = join(f.root, 'home');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    copyFileSync(f.plist, join(home, 'Library/LaunchAgents/com.mitzo.server.plist'));
    execFileSync('python3', [
      '-c',
      'import plistlib,sys;plistlib.dump({"WorkingDirectory":sys.argv[2],"ProgramArguments":[sys.argv[2]+"/scripts/start.sh"]},open(sys.argv[1],"wb"))',
      join(f.next, 'com.mitzo.server.plist'),
      f.next,
    ]);
    const result = spawnSync(
      '/bin/bash',
      [
        join(scripts, 'deploy.sh'),
        flag,
        flag === '--active-plist' ? join(f.root, 'absent.plist') : join(f.next, '.env'),
      ],
      { encoding: 'utf8', env: { HOME: home, PATH: bin + ':' + process.env.PATH } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported_deployment_argument');
    expect(() => readFileSync(marker)).toThrow();
  },
);

it('rejects an executable Program that overrides the supported start.sh argument', () => {
  const f = fixture();
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;p=plistlib.load(open(sys.argv[1],"rb"));p["Program"]="/bin/bash";plistlib.dump(p,open(sys.argv[1],"wb"))',
    f.plist,
  ]);
  expect(f.run().stderr).toContain('knowledge_enrollment_launcher_unsupported');
});
it('a missing active dotenv still preserves enrollment inherited from its plist', () => {
  const f = fixture({ candidate: false });
  rmSync(join(f.current, '.env'));
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;p=plistlib.load(open(sys.argv[1],"rb"));p["EnvironmentVariables"]={"MITZO_KNOWLEDGE_STORE_CONFIG":sys.argv[2],"PUBLICATION_TOKEN":"private-token"};plistlib.dump(p,open(sys.argv[1],"wb"))',
    f.plist,
    f.config,
  ]);
  expect(f.run().stderr).toContain('knowledge_enrollment_change_requires_opt_out');
});
it('accepts the supported candidate __MITZO_HOME__ launcher template', () => {
  const f = fixture();
  mkdirSync(join(f.next, 'scripts'));
  writeFileSync(join(f.next, 'scripts/start.sh'), '#!/bin/bash\n');
  const nextPlist = join(f.next, 'candidate.plist');
  execFileSync('python3', [
    '-c',
    'import plistlib,sys;plistlib.dump({"WorkingDirectory":"__MITZO_HOME__","ProgramArguments":["__MITZO_HOME__/scripts/start.sh"]},open(sys.argv[1],"wb"))',
    nextPlist,
  ]);
  expect(f.run(['--candidate-plist', nextPlist]).status).toBe(0);
});
