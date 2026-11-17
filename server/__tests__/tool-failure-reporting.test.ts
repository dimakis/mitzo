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
