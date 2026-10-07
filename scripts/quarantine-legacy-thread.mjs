#!/usr/bin/env node
/* global AbortSignal */
import process from 'node:process';
import console from 'node:console';
// Operator-only; dry-run by default. Requires an already stopped server and held inputs.
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fingerprint,
  snapshot,
  quarantine,
  collectDispatchProof,
  LEGACY_SCOPE,
  ownedInputFile as physical,
} from './repair-unpersisted-thread.mjs';
function need(ok, code) {
  if (!ok) throw new Error(code);
}
const argv = process.argv.slice(2);
function validateOptions(args) {
  const valued = new Set([
    '--accepted-head',
    '--env',
    '--database',
    '--events-database',
    '--conversation',
    '--expected',
    '--snapshot-out',
  ]);
  const switches = new Set(['--apply', '--confirmed-held-inputs']);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    need(
      (valued.has(flag) || switches.has(flag)) && !seen.has(flag),
      'quarantine_cli_options_invalid',
    );
    seen.add(flag);
    if (valued.has(flag)) {
      const argument = args[++i];
      need(argument && !argument.startsWith('--'), 'quarantine_cli_options_invalid');
      if (flag !== '--accepted-head' && flag !== '--conversation')
        need(isAbsolute(argument), 'quarantine_cli_options_invalid');
    }
  }
  need(!(seen.has('--apply') && seen.has('--snapshot-out')), 'quarantine_cli_options_invalid');
  need(!seen.has('--apply') || seen.has('--expected'), 'quarantine_cli_options_invalid');
  for (const flag of [
    '--accepted-head',
    '--env',
    '--database',
    '--events-database',
    '--conversation',
    '--confirmed-held-inputs',
  ])
    need(seen.has(flag), 'quarantine_cli_options_invalid');
  need(
    /^[a-f0-9]{40}$/.test(value('--accepted-head')) &&
      value('--conversation') === LEGACY_SCOPE.conversationId,
    'quarantine_cli_options_invalid',
  );
}
function value(flag) {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}
function serverOff() {
  const uid = process.getuid();
  const launch = spawnSync('/bin/launchctl', ['print', `gui/${uid}/com.mitzo.server`], {
    encoding: 'utf8',
  });
  const ports = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:3100', '-iTCP:3101', '-sTCP:LISTEN']);
  // Missing service only; launchctl errors/permission failures are not absence proof.
  return (
    launch.status !== 0 && /Could not find service/.test(launch.stderr ?? '') && ports.status === 1
  );
}
function installedEnvironment(suppliedPath) {
  // The installed service remains authoritative while stopped. A copied env
  // cannot redefine the ledger that this exact-target operator mutates.
  const home = userInfo().homedir;
  const plistPath = physical(join(home, 'Library/LaunchAgents/com.mitzo.server.plist'), false);
  const plist = JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  need(
    plist.Label === 'com.mitzo.server' &&
      (!plist.Program || plist.Program === join(plist.WorkingDirectory, 'scripts/start.sh')) &&
      isAbsolute(plist.WorkingDirectory ?? '') &&
      JSON.stringify(plist.ProgramArguments) ===
        JSON.stringify([join(plist.WorkingDirectory, 'scripts/start.sh')]),
    'installed_server_environment_required',
  );
  const installedBytes = readFileSync(physical(join(plist.WorkingDirectory, '.env')));
  need(
    installedBytes.equals(readFileSync(physical(suppliedPath))),
    'installed_server_environment_required',
  );
  const authored = dotenv.parse(installedBytes);
  const overrides = plist.EnvironmentVariables ?? {};
  need(
    overrides &&
      typeof overrides === 'object' &&
      !Array.isArray(overrides) &&
      Object.values(overrides).every((v) => typeof v === 'string'),
    'installed_server_environment_required',
  );
  const domain = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}`], {
    encoding: 'utf8',
  });
  need(!domain.error && domain.status === 0, 'installed_server_environment_required');
  const lines = (domain.stdout ?? '').split('\n');
  const starts = lines.flatMap((line, i) => (line === '\tenvironment = {' ? [i] : []));
  need(starts.length === 1, 'installed_server_environment_required');
  const end = lines.indexOf('\t}', starts[0] + 1);
  need(end >= 0, 'installed_server_environment_required');
  const inheritedNames = new Set();
  for (const line of lines.slice(starts[0] + 1, end)) {
    const match = /^\t\t([A-Za-z_][A-Za-z0-9_]*) => /.exec(line);
    need(match && !inheritedNames.has(match[1]), 'installed_server_environment_required');
    inheritedNames.add(match[1]);
  }
  const inherited = {};
  const controls = [
    'HOME',
    'MITZO_CODEX_PRIVATE_DIR',
    'REPO_PATH',
    'MITZO_OPENSHELL_LIFECYCLE_ENABLED',
    'DOTENV_CONFIG_PATH',
    'DOTENV_CONFIG_OVERRIDE',
    'DOTENV_CONFIG_ENCODING',
    'DOTENV_CONFIG_DOTENV_KEY',
    'DOTENV_KEY',
    'NODE_OPTIONS',
    'BASH_ENV',
    'ENV',
  ];
  for (const key of new Set([...Object.keys(authored), ...Object.keys(overrides), ...controls])) {
    if (!inheritedNames.has(key)) continue;
    const result = spawnSync('/bin/launchctl', ['getenv', key], { encoding: 'utf8' });
    need(
      !result.error && result.status === 0 && !result.stderr,
      'installed_server_environment_required',
    );
    if (result.status === 0) inherited[key] = (result.stdout ?? '').replace(/\n$/, '');
  }
  // dotenv/config fills absent inherited keys; plist values override launchd.
  const effective = { ...authored, ...inherited, ...overrides };
  need(
    effective.HOME === undefined || effective.HOME === home,
    'installed_server_environment_required',
  );
  for (const key of [
    'DOTENV_CONFIG_PATH',
    'DOTENV_CONFIG_OVERRIDE',
    'DOTENV_CONFIG_ENCODING',
    'DOTENV_CONFIG_DOTENV_KEY',
    'DOTENV_KEY',
    'NODE_OPTIONS',
    'BASH_ENV',
    'ENV',
  ])
    need(!effective[key], 'unsupported_installed_environment_override');
  effective.HOME = home;
  return effective;
}
async function main() {
  // Parse the complete operation before Git, files, services, native probes or SQLite.
  validateOptions(argv);
  const release = dirname(dirname(fileURLToPath(import.meta.url)));
  const accepted = value('--accepted-head');
  const git = (...a) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', release, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  need(
    /^[a-f0-9]{40}$/.test(accepted ?? '') &&
      git('rev-parse', 'HEAD') === accepted &&
      !git('status', '--porcelain', '--untracked-files=no') &&
      !git('branch', '--show-current'),
    'clean_accepted_detached_release_required',
  );
  need(
    ['https://github.com/dimakis/mitzo.git', 'git@github.com:dimakis/mitzo.git'].includes(
      git('remote', 'get-url', 'origin'),
    ),
    'canonical_remote_required',
  );
  need(
    git('ls-remote', 'origin', 'refs/heads/main') === `${accepted}\trefs/heads/main`,
    'current_accepted_remote_main_required',
  );
  need(
    argv.includes('--confirmed-held-inputs') && serverOff(),
    'confirmed_server_off_window_required',
  );
  const env = installedEnvironment(value('--env'));
  need(
    env.MITZO_OPENSHELL_LIFECYCLE_ENABLED !== '1',
    'lifecycle_enabled_recovery_requires_separate_review',
  );
  const privateDirectory =
    env.MITZO_CODEX_PRIVATE_DIR || join(env.HOME, '.mitzo', 'private', 'codex');
  need(isAbsolute(privateDirectory), 'authoritative_native_database_required');
  const database = physical(value('--database'), false);
  need(
    database === join(privateDirectory, 'conversations.db'),
    'authoritative_native_database_required',
  );
  const eventsDatabase = physical(value('--events-database'), false);
  need(
    eventsDatabase === join(env.REPO_PATH, '.mitzo/events.db'),
    'authoritative_events_database_required',
  );
  const id = value('--conversation');
  need(id && /^[a-f0-9-]{36}$/.test(id), 'explicit_selected_conversation_required');
  const apply = argv.includes('--apply');
  need(!apply || value('--expected'), 'reviewed_expected_snapshot_required');
  const expectedInput = value('--expected')
    ? JSON.parse(readFileSync(physical(value('--expected'))))
    : undefined;
  const db = new Database(database, { readonly: !apply, fileMustExist: true });
  const events = new Database(eventsDatabase, { readonly: true, fileMustExist: true });
  let ownsLock = false;
  const lock = `/tmp/com.mitzo.server.${process.getuid()}.deploy.lock`;
  try {
    if (apply) {
      execFileSync('/usr/bin/shlock', ['-f', lock, '-p', String(process.pid)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      ownsLock = true;
      db.pragma('synchronous = FULL');
    }
    const expected = expectedInput ?? snapshot(db, id);
    need(expected.conversationId === id, 'selected_snapshot_scope_changed');
    const row = db.prepare('SELECT artifact_runtime FROM codex_conversations WHERE id=?').get(id);
    const artifact = JSON.parse(row.artifact_runtime);
    const relation = JSON.parse(
      db.prepare('SELECT data FROM codex_runtime_migrations WHERE conversation_id=?').get(id).data,
    );
    const load = (path) => import(pathToFileURL(join(release, 'dist', path)));
    const { openShellRuntimeConfig, OpenShellRuntimeManager } = await load('openshell-runtime.js');
    const { observePodmanRuntimeImage } = await load('openshell-runtime-migration-adapter.js');
    const { openShellSshArgvProcessSpec } = await load('codex-app-server-client.js');
    const config = openShellRuntimeConfig(env);
    need(config, 'reviewed_openshell_config_required');
    const manager = new OpenShellRuntimeManager({
      ...config,
      account: artifact.route,
      sandboxNameOverride: artifact.runtime.sandboxName,
    });
    const sourceManager = new OpenShellRuntimeManager({
      ...config,
      account: relation.source.route,
      sandboxNameOverride: relation.source.runtime.sandboxName,
    });
    await manager.observeContract(id, artifact.runtime, AbortSignal.timeout(45000));
    await sourceManager.observeContract(id, relation.source.runtime, AbortSignal.timeout(45000));
    const image = await observePodmanRuntimeImage(artifact.runtime, AbortSignal.timeout(30000));
    need(image === relation.targetImage, 'candidate_actual_image_changed');
    const metadata = (runtime) => {
      const code = `import json,os,sqlite3\nfrom pathlib import Path\nroot=Path('/sandbox/.codex')\nif root.is_symlink() or (root/'sessions').is_symlink() or (root/'state_5.sqlite').is_symlink():raise Exception('unsupported provider root link')\nparent=${JSON.stringify(expected.parentThreadId)}\nchild=${JSON.stringify(expected.threadId)}\ncounts={'parentRolloutCount':0,'childRolloutCount':0}\nfor base,_,names in os.walk(root/'sessions',followlinks=False):\n for name in names:\n  if not name.startswith('rollout-') or not name.endswith('.jsonl'):continue\n  p=Path(base)/name\n  if p.is_symlink():raise Exception('unsupported rollout link')\n  with p.open('rb') as f:line=f.readline(65537)\n  if len(line)>65536:raise Exception('unsupported rollout metadata')\n  h=json.loads(line)\n  if h.get('type')=='session_meta':\n   thread=h.get('payload',{}).get('id')\n   if thread==parent:counts['parentRolloutCount']+=1\n   if thread==child:counts['childRolloutCount']+=1\ndb=sqlite3.connect('file:'+str(root/'state_5.sqlite')+'?mode=ro',uri=True)\ncounts['parentThreadRowCount']=db.execute('select count(*) from threads where id=?',(parent,)).fetchone()[0]\ncounts['childThreadRowCount']=db.execute('select count(*) from threads where id=?',(child,)).fetchone()[0]\ndb.close()\ncounts['nativeAppServerCount']=0\nfor entry in Path('/proc').iterdir():\n if not entry.name.isdigit():continue\n try:args=(entry/'cmdline').read_bytes().split(bytes([0]))\n except FileNotFoundError:continue\n if args and Path(os.fsdecode(args[0])).name=='codex' and b'app-server' in args:counts['nativeAppServerCount']+=1\nprint(json.dumps(counts))`;
      const spec = openShellSshArgvProcessSpec(runtime, ['/usr/bin/python3', '-I', '-c', code]);
      return {
        ...JSON.parse(
          execFileSync(spec.command, spec.args, {
            env: spec.env,
            encoding: 'utf8',
            timeout: 45000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ),
        physicalId: runtime.sandboxId,
      };
    };
    const observedAt = Date.now();
    const source = metadata(relation.source.runtime);
    const candidate = metadata(artifact.runtime);
    await manager.observeContract(id, artifact.runtime, AbortSignal.timeout(45000));
    await sourceManager.observeContract(id, relation.source.runtime, AbortSignal.timeout(45000));
    const readDispatchProof = () => collectDispatchProof(events);
    const evidence = {
      conversationId: id,
      childThreadId: expected.threadId,
      parentThreadId: expected.parentThreadId,
      bindingSha256: LEGACY_SCOPE.bindingSha256,
      source,
      candidate,
      dispatchProof: readDispatchProof(),
      contractVerified: true,
      lifecycleEnabled: false,
      observedAt,
    };
    need(
      fingerprint(installedEnvironment(value('--env'))) === fingerprint(env),
      'installed_server_environment_changed',
    );
    const result = quarantine({
      db,
      expected,
      evidence,
      assertServerOff: serverOff,
      confirmedHeldInputs: true,
      readDispatchProof,
      apply,
    });
    if (value('--snapshot-out')) {
      writeFileSync(value('--snapshot-out'), JSON.stringify(expected, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
    }
    console.log(JSON.stringify({ ...result, providerEvidenceFingerprint: fingerprint(evidence) }));
  } finally {
    events.close();
    db.close();
    if (ownsLock && readFileSync(lock, 'utf8').trim() === String(process.pid)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(lock);
    }
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: ['quarantine_cli_options_invalid', 'authoritative_native_database_required'].includes(
        error?.message,
      )
        ? error.message
        : 'quarantine_precondition_or_cas_failed',
      modelCalls: 0,
      serviceActions: 0,
    }),
  );
  process.exitCode = 1;
});
