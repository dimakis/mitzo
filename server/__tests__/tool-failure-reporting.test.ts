import { expect, it } from 'vitest';
import { isIntrinsicRecoveryRead } from '../builtin-tool-behavior.js';
import { qualifyToolResult, reportToolFailure } from '../tool-failure-reporting.js';
import { callbackOutcome, retainCallbackOutcome } from '../turn-callbacks.js';
import { CodexToolFailure } from '../codex-tool-failure.js';

it.each(['settled', 'unknown'] as const)(
  'preserves the original %s exception receipt over projected diagnostics',
  (outcome) => {
    const error = retainCallbackOutcome(
      new CodexToolFailure('invalid_input', {
        stage: 'tool_execution',
        reason: 'invalid_input',
        effectStatus: 'not_started',
      }),
      outcome,
    );
    const result = reportToolFailure(error, {
      sessionId: 'session',
      tool: 'AnyTool',
      signal: new AbortController().signal,
    });
    expect(result.isError).toBe(true);
    expect(callbackOutcome(result)).toBe(outcome);
  },
);

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
