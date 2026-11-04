import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeCodexSubagentContract,
  qualifyCodexSubagentContract,
} from '../qualify-codex-subagents.mjs';

// Reduced schemars shapes, not a recording of native execution. The CLI reads
// complete generated schemas from the explicitly selected executable.
function schemas() {
  const object = (fields: string[]) => ({
    properties: Object.fromEntries(fields.map((name) => [name, {}])),
    required: fields,
  });
  const methods = (names: string[]) =>
    names.map((method) => ({ properties: { method: { enum: [method] } } }));
  return {
    clients: {
      oneOf: methods([
        'thread/read',
        'thread/resume',
        'turn/start',
        'turn/steer',
        'turn/interrupt',
      ]),
      definitions: {
        TurnSteerParams: object(['threadId', 'expectedTurnId', 'input']),
        TurnStartParams: object(['threadId', 'input']),
        TurnInterruptParams: object(['threadId', 'turnId']),
        ThreadReadParams: object(['threadId']),
        ThreadResumeParams: object(['threadId']),
      },
    },
    notifications: {
      oneOf: methods([
        'thread/started',
        'turn/started',
        'turn/completed',
        'item/started',
        'item/completed',
        'item/agentMessage/delta',
      ]),
      definitions: {
        Thread: object(['id', 'parentThreadId', 'sessionId', 'forkedFromId']),
        ThreadItem: {
          oneOf: [
            {
              ...object([
                'id',
                'senderThreadId',
                'receiverThreadIds',
                'tool',
                'status',
                'agentsStates',
              ]),
              properties: {
                ...object([
                  'id',
                  'senderThreadId',
                  'receiverThreadIds',
                  'tool',
                  'status',
                  'agentsStates',
                ]).properties,
                type: { enum: ['collabAgentToolCall'] },
              },
            },
          ],
        },
        CollabAgentTool: { enum: ['spawnAgent', 'sendInput', 'wait', 'closeAgent'] },
      },
    },
    requests: {
      oneOf: methods(['item/tool/call']),
      definitions: {
        DynamicToolCallParams: object(['threadId', 'turnId', 'callId', 'tool', 'arguments']),
      },
    },
  };
}

describe('offline Codex subagent qualification', () => {
  it('records native parentage, child controls and tool attribution without claiming runtime support', () => {
    expect(qualifyCodexSubagentContract('0.160.0', schemas())).toEqual({
      codexCliVersion: '0.160.0',
      evidence: 'generated_protocol_only',
      modelCalls: 0,
      threadIdentityFields: ['id', 'parentThreadId', 'sessionId', 'forkedFromId'],
      collaborationItemType: 'collabAgentToolCall',
      collaborationIdentityFields: [
        'id',
        'senderThreadId',
        'receiverThreadIds',
        'tool',
        'status',
        'agentsStates',
      ],
      collaborationTools: ['spawnAgent', 'sendInput', 'wait', 'closeAgent'],
      controls: {
        'thread/read': ['threadId'],
        'thread/resume': ['threadId'],
        'turn/start': ['threadId', 'input'],
        'turn/steer': ['threadId', 'expectedTurnId', 'input'],
        'turn/interrupt': ['threadId', 'turnId'],
      },
      dynamicToolIdentityFields: ['threadId', 'turnId', 'callId', 'tool', 'arguments'],
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
    });
  });

  it.each(['parentThreadId', 'sessionId', 'forkedFromId'])(
    'rejects missing %s instead of guessing ancestry',
    (field) => {
      const input = schemas();
      delete input.notifications.definitions.Thread.properties[field];
      expect(() => qualifyCodexSubagentContract('0.160.0', input)).toThrow(`Thread.${field}`);
    },
  );

  it('rejects a steering contract without its required active-turn fence', () => {
    const input = schemas();
    input.clients.definitions.TurnSteerParams.required = ['threadId', 'input'];
    expect(() => qualifyCodexSubagentContract('0.160.0', input)).toThrow(
      'TurnSteerParams.expectedTurnId',
    );
  });

  it('rejects child controls that have params but are not exposed methods', () => {
    const input = schemas();
    input.clients.oneOf = input.clients.oneOf.filter(
      (entry) => entry.properties.method.enum[0] !== 'turn/interrupt',
    );
    expect(() => qualifyCodexSubagentContract('0.160.0', input)).toThrow('turn/interrupt');
  });

  it('rejects unobservable child output and missing dynamic tool ownership', () => {
    const input = schemas();
    input.notifications.oneOf = input.notifications.oneOf.filter(
      (entry) => entry.properties.method.enum[0] !== 'item/agentMessage/delta',
    );
    expect(() => qualifyCodexSubagentContract('0.160.0', input)).toThrow('item/agentMessage/delta');
    const tools = schemas();
    tools.requests.definitions.DynamicToolCallParams.required = [
      'threadId',
      'callId',
      'tool',
      'arguments',
    ];
    expect(() => qualifyCodexSubagentContract('0.160.0', tools)).toThrow(
      'DynamicToolCallParams.turnId',
    );
  });

  it('requires native spawn/send/wait/close while retaining additional advertised tools', () => {
    const input = schemas();
    input.notifications.definitions.CollabAgentTool.enum.push('interruptAgent');
    expect(qualifyCodexSubagentContract('0.160.0', input).collaborationTools).toContain(
      'interruptAgent',
    );
    input.notifications.definitions.CollabAgentTool.enum = ['spawnAgent'];
    expect(() => qualifyCodexSubagentContract('0.160.0', input)).toThrow('sendInput');
  });

  it('fails closed on missing or malformed generated schemas', () => {
    expect(() => qualifyCodexSubagentContract('0.160.0', {})).toThrow('ClientRequest');
    expect(() => qualifyCodexSubagentContract('not-a-version', schemas())).toThrow('version');
  });
});

describe('selected executable probe', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function fixture(version?: string) {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-subagent-probe-test-'));
    temporary.push(root);
    const executable = join(root, 'codex');
    const output = join(root, 'report.json');
    const log = join(root, 'calls.jsonl');
    const pinned = readFileSync(
      new URL('../../docs/spikes/openshell-codex/runtime-codex-version', import.meta.url),
      'utf8',
    ).trim();
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.HOME, codexHome: process.env.CODEX_HOME, env: Object.keys(process.env) }) + '\\n');
if (args[0] === '--version') console.log(${JSON.stringify(`codex-cli ${version ?? pinned}`)});
else {
  if (args.join(' ').split(' --out ')[0] !== 'app-server generate-json-schema --experimental') process.exit(1);
  const directory = args.at(-1);
  fs.mkdirSync(directory);
  const input = ${JSON.stringify(schemas())};
  for (const [name, value] of Object.entries({ ClientRequest: input.clients, ServerNotification: input.notifications, ServerRequest: input.requests })) fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify(value));
}
`,
      { mode: 0o700 },
    );
    return { executable, output, log };
  }

  it('probes only version/schema commands with temporary empty homes and records input hashes', () => {
    const f = fixture();
    probeCodexSubagentContract(f.executable, f.output);
    const report = JSON.parse(readFileSync(f.output, 'utf8'));
    expect(report).toMatchObject({
      executionQualified: false,
      modelCalls: 0,
      executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.keys(report.schemaSha256)).toEqual([
      'ClientRequest.json',
      'ServerNotification.json',
      'ServerRequest.json',
    ]);
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['--version']);
    expect(calls[1].args.slice(0, 4)).toEqual([
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
    ]);
    expect(calls[0].home).not.toBe(process.env.HOME);
    expect(calls[0].codexHome).not.toBe(process.env.CODEX_HOME);
    expect(calls[0].env).not.toContain('AUTH_SECRET');
    expect(existsSync(calls[0].home)).toBe(false);
    expect(existsSync(calls[0].codexHome)).toBe(false);
  });

  it('rejects another version before generation and leaves no report', () => {
    const f = fixture('9.999.0');
    expect(() => probeCodexSubagentContract(f.executable, f.output)).toThrow('pinned Codex');
    expect(readFileSync(f.log, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(f.output)).toBe(false);
  });

  it('preserves earlier evidence without launching another probe', () => {
    const f = fixture();
    writeFileSync(f.output, 'retained evidence');
    expect(() => probeCodexSubagentContract(f.executable, f.output)).toThrow('already exists');
    expect(readFileSync(f.output, 'utf8')).toBe('retained evidence');
    expect(existsSync(f.log)).toBe(false);
  });
});
