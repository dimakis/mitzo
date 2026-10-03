/** Read-only deployment check. Never include settings, paths or credentials in diagnostics. */
import console from 'node:console';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';

const key = 'MITZO_KNOWLEDGE_STORE_CONFIG';
const fail = (code) => {
  throw new Error(code);
};
function read(path) {
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) fail('knowledge_enrollment_metadata_unreadable');
  return bytes;
}
function plist(path, optional = false) {
  try {
    read(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
  // plistlib supports XML and binary launchd plists. Return only enrollment and
  // credential presence; no credential value crosses the helper's stdout.
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import json,plistlib,sys
with open(sys.argv[1],'rb') as f: p=plistlib.load(f)
e=p.get('EnvironmentVariables',{})
if not isinstance(e,dict) or any(not isinstance(k,str) or not isinstance(v,str) for k,v in e.items()): raise ValueError()
print(json.dumps({'directory':p.get('WorkingDirectory'),'enrollment':e.get('${key}'),'presence':{k:bool(v) for k,v in e.items()}}))
`,
        path,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 },
    ),
  );
}
function environment(path, overrides) {
  const env = parse(read(path));
  const unsupported = (name) =>
    new Set([
      'DOTENV_CONFIG_PATH',
      'DOTENV_CONFIG_ENCODING',
      'DOTENV_CONFIG_OVERRIDE',
      'DOTENV_CONFIG_DOTENV_KEY',
      'DOTENV_KEY',
    ]).has(name);
  if (
    Object.keys(overrides?.presence ?? {}).some(
      (name) => unsupported(name) && overrides.presence[name],
    ) ||
    Object.keys(env).some((name) => unsupported(name) && env[name])
  )
    fail('knowledge_enrollment_dotenv_override_unsupported');
  if (key in (overrides?.presence ?? {})) env[key] = overrides.enrollment;
  const present = (name) =>
    name in (overrides?.presence ?? {}) ? overrides.presence[name] : !!env[name];
  return { env, present };
}
function enrollment({ env, present }) {
  if (!env[key]) return undefined;
  if (!isAbsolute(env[key])) fail('knowledge_enrollment_metadata_unreadable');
  const config = JSON.parse(read(env[key]).toString('utf8'));
  if (!config || typeof config.defaultStore !== 'string' || !Array.isArray(config.stores))
    fail('knowledge_enrollment_metadata_unreadable');
  const selected = config.stores.filter((store) => store?.id === config.defaultStore);
  if (selected.length !== 1 || !isAbsolute(selected[0].publisherConfig ?? ''))
    fail('knowledge_enrollment_metadata_unreadable');
  const publisher = JSON.parse(read(selected[0].publisherConfig).toString('utf8'));
  if (
    typeof publisher.readTokenEnv !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(publisher.readTokenEnv)
  )
    fail('knowledge_enrollment_metadata_unreadable');
  return {
    path: realpathSync(env[key]),
    config,
    credentialPresent: present(publisher.readTokenEnv),
  };
}
try {
  const { values } = parseArgs({
    options: {
      'candidate-env': { type: 'string', default: '.env' },
      'candidate-plist': { type: 'string' },
      'active-plist': {
        type: 'string',
        default: join(homedir(), 'Library/LaunchAgents/com.mitzo.server.plist'),
      },
      'allow-knowledge-enrollment-change': { type: 'boolean', default: false },
    },
  });
  const active = plist(values['active-plist'], true);
  const nextPlist = values['candidate-plist'] ? plist(values['candidate-plist']) : undefined;
  const candidate = enrollment(environment(values['candidate-env'], nextPlist));
  let previous;
  if (active) {
    if (typeof active.directory !== 'string' || !isAbsolute(active.directory))
      fail('knowledge_enrollment_metadata_unreadable');
    previous = enrollment(environment(join(active.directory, '.env'), active));
  }
  const changed =
    previous &&
    (!candidate ||
      previous.path !== candidate.path ||
      !isDeepStrictEqual(previous.config, candidate.config));
  if (changed && !values['allow-knowledge-enrollment-change'])
    fail('knowledge_enrollment_change_requires_opt_out');
  // Token rotation is valid. A shell-only token is not evidence that the newly
  // generated LaunchAgent will receive it: only candidate dotenv/plist count.
  if (candidate && !candidate.credentialPresent) fail('knowledge_enrollment_credential_missing');
  console.log(
    JSON.stringify({
      knowledgeEnrollment: changed
        ? 'explicit-change'
        : candidate
          ? 'preserved-or-initial'
          : 'unenrolled',
    }),
  );
} catch (error) {
  const codes = new Set([
    'knowledge_enrollment_metadata_unreadable',
    'knowledge_enrollment_change_requires_opt_out',
    'knowledge_enrollment_credential_missing',
    'knowledge_enrollment_dotenv_override_unsupported',
  ]);
  console.error(
    JSON.stringify({
      error: codes.has(error.message) ? error.message : 'knowledge_enrollment_metadata_unreadable',
    }),
  );
  process.exitCode = 1;
}
