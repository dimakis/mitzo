import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SymposiumAttemptRegistry,
  type SymposiumAttemptTransport,
} from '../symposium-attempt-registry.js';
import { claudeVertexArgv, createClaudeVertexSeat } from '../symposium-claude-native.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sandbox = { sandboxName: 'symfixture', workdir: '/sandbox/workspaces/mgmt' };
const route = {
  kind: 'claude-vertex' as const,
  provider: 'fixture-provider',
  providerId: 'fixture-object',
  model: 'fixture-model',
  effort: 'low',
  projectId: 'fixture-project',
  region: 'us-east5',
  readOnly: true,
};
const execution = {
  sessionId: 'session-1',
  deliveryId: 'delivery-1',
  claimToken: 'claim-1',
  idempotencyKey: 'attempt-1',
  content: 'Only this routed excerpt.',
  seat: {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'fixture-model',
    systemPrompt: 'Read only.',
    color: '#112233',
    role: 'reviewer',
  },
  provenance: { membershipGeneration: 2 },
  signal: new AbortController().signal,
} as SymposiumSeatExecution;

function harness(confirm: SymposiumAttemptTransport['confirm']) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-controller-'));
  chmodSync(directory, 0o700);
  dirs.push(directory);
  const path = join(directory, 'claims.db');
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const launch = vi.fn(() => ({
    child,
    confirmStopped: async () => undefined,
  })) as unknown as SymposiumAttemptTransport['launch'];
  const registry = new SymposiumAttemptRegistry(path, { launch, confirm });
  return { registry, path, child, launch };
}

function event(child: ReturnType<typeof harness>['child'], value: unknown) {
  child.stdout.write(JSON.stringify(value) + '\n');
}

describe('Claude fixture over claim controller and durable registry', () => {
  it('streams routed input, records the assistant receipt, and confirms terminal cleanup', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined) as SymposiumAttemptTransport['confirm'];
    const { child, launch, registry } = harness(confirm);
    let sent = '';
    child.stdin.on('data', (chunk) => (sent += chunk.toString()));
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution,
      attemptRegistry: registry,
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const receipts: string[] = [];
    const run = native.run(execution, {
      beforeDispatch: () => receipts.push('dispatch'),
      accepted: (id, turn) => receipts.push(`${id}:${turn}`),
    });
    expect(registry.get(execution.claimToken)?.state).toBe('reserved');
    expect(launch).toHaveBeenCalledWith(sandbox, execution.claimToken, 'read', argv);
    expect(argv).not.toContain(execution.content);
    event(child, { type: 'system', subtype: 'init', session_id: thread });
    expect(receipts).toEqual(['dispatch']);
    event(child, {
      type: 'assistant',
      session_id: thread,
      message: { id: 'message-1', content: [{ type: 'text', text: 'Reviewed.' }] },
    });
    event(child, { type: 'result', session_id: thread, is_error: false, total_cost_usd: 0.01 });
    child.emit('close', 0);
    await expect(run).resolves.toEqual({
      providerThreadId: thread,
      content: 'Reviewed.',
      costUsd: 0.01,
    });
    expect(sent).toBe(execution.content);
    expect(receipts).toEqual(['dispatch', `${thread}:message-1`]);
    expect(confirm).toHaveBeenCalledWith(sandbox, execution.claimToken);
    expect(registry.get(execution.claimToken)?.state).toBe('confirmed');
    registry.close();
  });

  it('cancels the exact claim and does not mistake transport closure for a result', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined) as SymposiumAttemptTransport['confirm'];
    const { child, registry } = harness(confirm);
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution,
      attemptRegistry: registry,
    });
    const run = native.run(execution, {
      beforeDispatch: () => undefined,
      accepted: () => undefined,
    });
    await native.cancel();
    expect(confirm).toHaveBeenCalledWith(sandbox, execution.claimToken);
    child.emit('close', 0);
    await expect(run).rejects.toThrow(/uncertain outcome/);
    expect(registry.get(execution.claimToken)?.state).toBe('confirmed');
    registry.close();
  });

  it('refuses a successful result without an assistant acceptance receipt', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined) as SymposiumAttemptTransport['confirm'];
    const { child, registry } = harness(confirm);
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution,
      attemptRegistry: registry,
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const accepted = vi.fn();
    const run = native.run(execution, { beforeDispatch: () => undefined, accepted });
    event(child, { type: 'system', subtype: 'init', session_id: thread });
    event(child, { type: 'result', session_id: thread, is_error: false });
    child.emit('close', 0);
    await expect(run).rejects.toThrow(/uncertain outcome/);
    expect(accepted).not.toHaveBeenCalled();
    expect(registry.get(execution.claimToken)?.state).toBe('uncertain');
    registry.close();
  });

  it('quarantines observer loss after apparent provider success across restart', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValue(new Error('observer lost')) as SymposiumAttemptTransport['confirm'];
    const { child, registry, path } = harness(confirm);
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution,
      attemptRegistry: registry,
    });
    const argv = claudeVertexArgv(route, execution);
    const thread = argv[argv.indexOf('--session-id') + 1];
    const run = native.run(execution, {
      beforeDispatch: () => undefined,
      accepted: () => undefined,
    });
    event(child, {
      type: 'assistant',
      session_id: thread,
      message: { id: 'message-1', content: [] },
    });
    event(child, { type: 'result', session_id: thread, is_error: false });
    child.emit('close', 0);
    await expect(run).rejects.toThrow(/uncertain outcome/);
    expect(registry.get(execution.claimToken)?.state).toBe('uncertain');
    await expect(native.cancel()).rejects.toThrow(/quarantined/);
    registry.close();
    const restarted = new SymposiumAttemptRegistry(path, {
      launch: vi.fn() as unknown as SymposiumAttemptTransport['launch'],
      confirm,
    });
    expect(() => restarted.assertSandboxAvailable(sandbox.sandboxName)).toThrow(/quarantined/);
    restarted.close();
  });

  it('binds resumed fixture events to the pinned prior thread', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined) as SymposiumAttemptTransport['confirm'];
    const { child, registry } = harness(confirm);
    const resumed = { ...execution, providerThreadId: 'prior-thread' } as SymposiumSeatExecution;
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution: resumed,
      attemptRegistry: registry,
    });
    expect(claudeVertexArgv(route, resumed)).toContain('--resume');
    const accepted = vi.fn();
    const run = native.run(resumed, { beforeDispatch: () => undefined, accepted });
    event(child, {
      type: 'assistant',
      session_id: 'wrong-thread',
      message: { id: 'message-1', content: [] },
    });
    await expect(run).rejects.toThrow(/uncertain outcome/);
    expect(accepted).not.toHaveBeenCalled();
    expect(registry.get(execution.claimToken)?.state).toBe('uncertain');
    registry.close();
  });

  it('accepts a matching resumed thread and never starts a replacement session', async () => {
    const confirm = vi.fn().mockResolvedValue(undefined) as SymposiumAttemptTransport['confirm'];
    const { child, registry, launch } = harness(confirm);
    const resumed = { ...execution, providerThreadId: 'prior-thread' } as SymposiumSeatExecution;
    const native = await createClaudeVertexSeat({
      sandbox,
      route,
      execution: resumed,
      attemptRegistry: registry,
    });
    const accepted = vi.fn();
    const run = native.run(resumed, { beforeDispatch: () => undefined, accepted });
    const command = vi.mocked(launch).mock.calls[0][3];
    expect(command).toContain('--resume');
    expect(command).not.toContain('--session-id');
    event(child, {
      type: 'assistant',
      session_id: 'prior-thread',
      message: { id: 'resume-message', content: [{ type: 'text', text: 'Continued.' }] },
    });
    event(child, { type: 'result', session_id: 'prior-thread', is_error: false });
    child.emit('close', 0);
    await expect(run).resolves.toEqual({ providerThreadId: 'prior-thread', content: 'Continued.' });
    expect(accepted).toHaveBeenCalledWith('prior-thread', 'resume-message');
    registry.close();
  });
});
