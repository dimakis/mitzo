import { LocalRepositoryGitInspectionError } from '../local-repository-git-inspection.js';
import { expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    warn: (_message: string, fields: Record<string, unknown>) => logged.push(fields),
    info: () => {},
    debug: () => {},
    error: () => {},
  }),
}));
import { isIntrinsicRecoveryRead } from '../builtin-tool-behavior.js';
import { qualifyToolResult, reportToolFailure } from '../tool-failure-reporting.js';
import { callbackOutcome, retainCallbackOutcome } from '../turn-callbacks.js';
import { annotateAuthorityFailure } from '../runtime-failure-diagnostics.js';
import { AgentCommunicationError } from '../agent-message-runtime.js';
import { runGuardedTool, ToolGuardRetiredError } from '@mitzo/harness';
import { AsyncLocalStorage } from 'node:async_hooks';

it.each([
  ['ReadKnowledge', {}],
  ['GoogleWorkspaceRead', {}],
  ['AgentReadTasks', {}],
  ['TaskExecution', { operation: 'github_read' }],
  ['SessionTimers', { operation: 'read' }],
  ['TelosManageItem', { operation: 'read' }],
] as const)('shares default read failure recovery for %s', (name, input) => {
  expect(isIntrinsicRecoveryRead(name, input)).toBe(true);
  const original = { content: 'Original failed observation', isError: true };
  expect(qualifyToolResult(name, input, new AbortController().signal, original)).toBe(original);
  expect(callbackOutcome(original)).toBe('settled');
});

it.each([
  ['TaskExecution', { operation: 'run' }],
  ['TaskExecution', { operation: 'commit' }],
  ['TaskExecution', {}],
  ['ConnectionRequest', { method: 'GET' }],
  ['RequestWebAccess', { operation: 'fetch' }],
  ['TelosManageItem', { operation: 'edit' }],
  ['mcp__configured__ReadKnowledge', {}],
] as const)('does not infer intrinsic recovery authority for %s %j', (name, input) => {
  expect(isIntrinsicRecoveryRead(name, input)).toBe(false);
});

it('preserves explicit uncertainty, cancellation, and known write failure receipts', () => {
  const signal = new AbortController();
  const unknown = retainCallbackOutcome({ content: 'uncertain', isError: true }, 'unknown');
  expect(callbackOutcome(qualifyToolResult('Read', {}, signal.signal, unknown))).toBe('unknown');
  signal.abort();
  expect(
    callbackOutcome(
      qualifyToolResult('Read', {}, signal.signal, { content: 'cancelled', isError: true }),
    ),
  ).toBe('unknown');
  const failedWrite = retainCallbackOutcome(
    { content: 'Refused before write', isError: true },
    'settled',
  );
  expect(qualifyToolResult('AnyWriteTool', {}, new AbortController().signal, failedWrite)).toBe(
    failedWrite,
  );
  expect(callbackOutcome(failedWrite)).toBe('settled');
});

it('reports safe reasons without serializing the upstream payload or granting replay', () => {
  const result = reportToolFailure(Object.assign(Error('token=private'), { code: 'ENOMEM' }), {
    sessionId: 'session',
    callId: 'call',
    tool: 'AnyTool',
    signal: new AbortController().signal,
  });
  expect(JSON.parse(result.content)).toMatchObject({
    diagnostic: { reason: 'memory_exhausted', effectStatus: 'unknown' },
    failure: { recovery: 'inspect_operation' },
  });
  expect(result.content).not.toContain('private');
  expect(callbackOutcome(result)).toBe('unknown');
});

it('logs the cause chain by class and errno only, so unknown failures stay diagnosable', () => {
  logged.length = 0;
  const cause = Object.assign(Error('/Users/private/repo denied'), { code: 'EPERM' });
  reportToolFailure(Error('Local repository native reads unavailable', { cause }), {
    sessionId: 'session',
    tool: 'DiscoverLocalRepository',
    signal: new AbortController().signal,
  });
  expect(logged.at(-1)).toMatchObject({
    tool: 'DiscoverLocalRepository',
    causes: [{ name: 'Error' }, { name: 'Error', code: 'EPERM' }],
  });
  expect(JSON.stringify(logged.at(-1))).not.toContain('/Users/private');
});

it('logs the code-owned kind and reason of a local repository read refusal', () => {
  logged.length = 0;
  reportToolFailure(new LocalRepositoryGitInspectionError('access', 'read-anchor-required'), {
    sessionId: 'session',
    tool: 'DiscoverLocalRepository',
    signal: new AbortController().signal,
  });
  expect(logged.at(-1)).toMatchObject({
    causes: [
      { name: 'LocalRepositoryGitInspectionError', kind: 'access', reason: 'read-anchor-required' },
    ],
  });
});

it('retains annotated SDK authority checks without leaking the original error', () => {
  logged.length = 0;
  const cause = annotateAuthorityFailure(Error('private upstream payload'), 'sdk.command_tool');
  reportToolFailure(cause, {
    sessionId: 'sdk-owned',
    tool: 'TaskExecution',
    signal: new AbortController().signal,
  });
  expect(logged.at(-1)).toMatchObject({
    sessionId: 'sdk-owned',
    tool: 'TaskExecution',
    failedCheck: 'sdk.command_tool',
    authorityChecks: ['sdk.command_tool'],
  });
  expect(JSON.stringify(logged.at(-1))).not.toContain('private upstream payload');
});

it('logs a stable code and stage when a callback reaches a settled tool guard', async () => {
  logged.length = 0;
  let captured!: ReturnType<typeof AsyncLocalStorage.snapshot>;
  await runGuardedTool({ signal: new AbortController().signal }, async () => {
    // A resource created inside a call keeps that call's async context.
    captured = AsyncLocalStorage.snapshot();
  });
  const error = await captured(() =>
    runGuardedTool({ signal: new AbortController().signal }, async () => 'late'),
  ).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(ToolGuardRetiredError);
  reportToolFailure(error, {
    sessionId: 'peer-started',
    tool: 'AgentCommunication',
    signal: new AbortController().signal,
  });
  expect(logged.at(-1)).toMatchObject({
    causes: [{ name: 'ToolGuardRetiredError', code: 'tool_callback_retired', stage: 'tool_guard' }],
  });
});

it('logs the code-owned stage of an agent communication refusal', () => {
  logged.length = 0;
  reportToolFailure(
    new AgentCommunicationError('sender_authority_changed', 'authorization', 'Changed.'),
    { sessionId: 'session', tool: 'AgentCommunication', signal: new AbortController().signal },
  );
  expect(logged.at(-1)).toMatchObject({
    causes: [
      { name: 'AgentCommunicationError', code: 'sender_authority_changed', stage: 'authorization' },
    ],
  });
});
