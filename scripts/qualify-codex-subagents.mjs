import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const controls = {
  'thread/read': ['ThreadReadParams', ['threadId']],
  'thread/resume': ['ThreadResumeParams', ['threadId']],
  'turn/start': ['TurnStartParams', ['threadId', 'input']],
  'turn/steer': ['TurnSteerParams', ['threadId', 'expectedTurnId', 'input']],
  'turn/interrupt': ['TurnInterruptParams', ['threadId', 'turnId']],
};

function requireMethods(schema, name, methods) {
  const exposed = schema?.oneOf?.flatMap((entry) => entry.properties?.method?.enum ?? []);
  if (!Array.isArray(exposed)) throw new Error(`Missing ${name} method schema`);
  for (const method of methods)
    if (!exposed.includes(method)) throw new Error(`Missing ${name} method ${method}`);
}

function requireFields(schema, name, fields, required = false) {
  for (const field of fields)
    if (
      !Object.hasOwn(schema?.properties ?? {}, field) ||
      (required && !schema.required?.includes(field))
    )
      throw new Error(`Missing ${required ? 'required ' : ''}${name}.${field}`);
  return fields;
}

/** Field/method inventory only. Schema generation cannot qualify execution,
 * dynamic-tool inheritance, subscription semantics or descendant cancellation. */
export function qualifyCodexSubagentContract(version, schemas) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Codex version');
  requireMethods(schemas.clients, 'ClientRequest', Object.keys(controls));
  requireMethods(schemas.notifications, 'ServerNotification', [
    'thread/started',
    'turn/started',
    'turn/completed',
    'item/started',
    'item/completed',
    'item/agentMessage/delta',
  ]);
  requireMethods(schemas.requests, 'ServerRequest', ['item/tool/call']);
  const definitions = schemas.notifications.definitions;
  const activity = definitions?.ThreadItem?.oneOf?.find((item) =>
    item.properties?.type?.enum?.includes('subAgentActivity'),
  );
  const subagentActivityKinds = definitions?.SubAgentActivityKind?.enum;
  for (const kind of ['started', 'interacted', 'completed'])
    if (!subagentActivityKinds?.includes(kind))
      throw new Error(`Missing subAgentActivity kind ${kind}`);
  const collaboration = definitions?.ThreadItem?.oneOf?.find((item) =>
    item.properties?.type?.enum?.includes('collabAgentToolCall'),
  );
  const collaborationTools = definitions?.CollabAgentTool?.enum;
  for (const tool of ['spawnAgent', 'sendInput', 'wait', 'closeAgent'])
    if (!collaborationTools?.includes(tool)) throw new Error(`Missing collaboration tool ${tool}`);

  return {
    codexCliVersion: version,
    evidence: 'generated_protocol_only',
    modelCalls: 0,
    threadIdentityFields: requireFields(definitions?.Thread, 'Thread', [
      'id',
      'parentThreadId',
      'sessionId',
      'forkedFromId',
    ]),
    subagentActivityFields: requireFields(
      activity,
      'subAgentActivity',
      ['id', 'kind', 'agentThreadId', 'agentPath'],
      true,
    ),
    subagentActivityKinds,
    collaborationItemType: 'collabAgentToolCall',
    collaborationIdentityFields: requireFields(collaboration, 'collabAgentToolCall', [
      'id',
      'senderThreadId',
      'receiverThreadIds',
      'tool',
      'status',
      'agentsStates',
    ]),
    collaborationTools,
    controls: Object.fromEntries(
      Object.entries(controls).map(([method, [name, fields]]) => [
        method,
        requireFields(schemas.clients.definitions?.[name], name, fields, true),
      ]),
    ),
    dynamicToolIdentityFields: requireFields(
      schemas.requests.definitions?.DynamicToolCallParams,
      'DynamicToolCallParams',
      ['threadId', 'turnId', 'callId', 'tool', 'arguments'],
      true,
    ),
    executionQualified: false,
    remainingChecks: [
      'child_event_subscription_and_replay',
      'dynamic_tool_inheritance_and_approval_routing',
      'account_workspace_and_permission_inheritance',
      'active_and_idle_child_messaging',
      'targeted_and_descendant_cancellation',
      'reconnect_and_uncertain_effect_recovery',
      'child_usage_accounting',
    ],
  };
}

export function probeCodexSubagentContract(executable, output) {
  if (existsSync(output)) throw new Error('Report output already exists');
  if (!isAbsolute(executable)) throw new Error('Select an absolute Codex executable path');
  const selected = realpathSync(executable);
  const version = readFileSync(
    new URL('../docs/spikes/openshell-codex/runtime-codex-version', import.meta.url),
    'utf8',
  ).trim();
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const executableSha256 = sha256(readFileSync(selected));
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-subagent-contract-'));
  try {
    const home = join(directory, 'home');
    const codexHome = join(directory, 'codex');
    mkdirSync(home);
    mkdirSync(codexHome);
    const options = {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: codexHome,
        TMPDIR: directory,
        LANG: 'C',
      },
      cwd: directory,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    };
    if (execFileSync(selected, ['--version'], options).trim() !== `codex-cli ${version}`)
      throw new Error(`Select the pinned Codex ${version}; no schema generation was attempted`);
    const schemaDirectory = join(directory, 'schema');
    execFileSync(
      selected,
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDirectory],
      options,
    );
    const schemaSha256 = {};
    const read = (name) => {
      const relative = existsSync(join(schemaDirectory, `${name}.json`))
        ? `${name}.json`
        : `v2/${name}.json`;
      const bytes = readFileSync(join(schemaDirectory, relative));
      schemaSha256[relative] = sha256(bytes);
      return JSON.parse(bytes.toString('utf8'));
    };
    const report = qualifyCodexSubagentContract(version, {
      clients: read('ClientRequest'),
      notifications: read('ServerNotification'),
      requests: read('ServerRequest'),
    });
    if (sha256(readFileSync(selected)) !== executableSha256)
      throw new Error('Selected Codex executable changed during generation');
    writeFileSync(
      output,
      JSON.stringify({ ...report, executableSha256, schemaSha256 }, null, 2) + '\n',
      { flag: 'wx' },
    );
    return report;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [executable, output, ...extra] = process.argv.slice(2);
  if (!executable || !output || extra.length)
    throw new Error(
      'Usage: node scripts/qualify-codex-subagents.mjs ABSOLUTE_CODEX_PATH NEW_REPORT_PATH',
    );
  probeCodexSubagentContract(executable, output);
}
