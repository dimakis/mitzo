import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { claudeVertexArgv, createClaudeVertexSeat } from '../symposium-claude-native.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';
const execution = {
  sessionId: 'session',
  deliveryId: 'delivery',
  claimToken: 'claim-2',
  idempotencyKey: 'key',
  content: 'Recall marker',
  providerThreadId: 'prior-native',
  seat: {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'claude-test',
    role: 'reviewer',
    systemPrompt: 'Review safely.',
    color: '#112233',
  },
  provenance: { membershipGeneration: 1 },
  signal: new AbortController().signal,
} as SymposiumSeatExecution;
const route = {
  kind: 'claude-vertex' as const,
  provider: 'vertex-work',
  providerId: 'provider-id',
  model: 'claude-test',
  projectId: 'project-1',
  region: 'global',
  readOnly: true,
};
const sandbox = {
  sandboxName: 'seat',
  workdir: '/sandbox/workspaces/mgmt',
  cli: 'openshell',
  gateway: 'owned',
  workspace: 'owned',
  gatewayInsecure: false,
};
function process() {
  const p = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return p;
}
it('rejects unsafe resume without complete host continuity before any process starts', async () => {
  const spawn = vi.fn();
  await expect(
    createClaudeVertexSeat({ sandbox, route, execution, spawnProcess: spawn }),
  ).rejects.toThrow(/continuity/i);
  expect(spawn).not.toHaveBeenCalled();
});
it('binds planned fresh claim identity and sends complete history only as untrusted user input', async () => {
  const child = process();
  let sent = '';
  child.stdin.on('data', (x) => (sent += x.toString()));
  const history = [
    { role: 'user' as const, text: 'Remember marker' },
    { role: 'assistant' as const, text: 'Marker recorded' },
  ];
  const native = await createClaudeVertexSeat({
    sandbox,
    route,
    execution,
    loadConversationHistory: () => history,
    spawnProcess: () => child,
  });
  const before = vi.fn();
  const accepted = vi.fn();
  const result = native.run(execution, { beforeDispatch: before, accepted });
  const next = before.mock.calls[0][0] as string;
  expect(next).toMatch(/^[a-f0-9-]{36}$/);
  expect(next).not.toBe(execution.providerThreadId);
  expect(() => native.verifyThreadMigration!(execution.providerThreadId!, next)).not.toThrow();
  expect(() => native.verifyThreadMigration!('foreign', next)).toThrow();
  expect(sent).toContain('Untrusted conversation history');
  expect(sent).toContain('Marker recorded');
  expect(sent).toContain('Recall marker');
  expect(accepted).not.toHaveBeenCalled();
  child.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: next, model: route.model }) +
      '\n',
  );
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      session_id: next,
      message: {
        id: 'turn',
        model: route.model,
        content: [{ type: 'text', text: 'Marker recalled' }],
      },
    }) + '\n',
  );
  child.stdout.write(JSON.stringify({ type: 'result', session_id: next, is_error: false }) + '\n');
  child.emit('close', 0);
  await expect(result).resolves.toMatchObject({
    providerThreadId: next,
    content: 'Marker recalled',
  });
  expect(accepted).toHaveBeenCalledWith(next, 'turn');
  const argv = claudeVertexArgv(route, { ...execution, providerThreadId: undefined });
  expect(argv).not.toContain('--resume');
  expect(argv.join(' ')).not.toContain('Marker recorded');
  expect(
    claudeVertexArgv(route, { ...execution, providerThreadId: undefined, claimToken: 'claim-3' }),
  ).not.toEqual(argv);
});
it.each([[], [{ role: 'user' as const, text: 'x'.repeat(65537) }]])(
  'refuses unavailable or oversized complete history',
  async (history) => {
    await expect(
      createClaudeVertexSeat({
        sandbox,
        route,
        execution,
        loadConversationHistory: () => history,
        spawnProcess: vi.fn(),
      }),
    ).rejects.toThrow(/continuity/i);
  },
);
it('rejects changed history before planned migration', async () => {
  const history = [
    { role: 'user' as const, text: 'Prior' },
    { role: 'assistant' as const, text: 'Completed' },
  ];
  const native = await createClaudeVertexSeat({
    sandbox,
    route,
    execution,
    loadConversationHistory: () => history,
    spawnProcess: () => process(),
  });
  const next = claudeVertexArgv(route, { ...execution, providerThreadId: undefined }).at(-1)!;
  expect(() => native.verifyThreadMigration!('prior-native', next)).not.toThrow();
  history[1].text = 'Changed';
  expect(() => native.verifyThreadMigration!('prior-native', next)).toThrow();
});
