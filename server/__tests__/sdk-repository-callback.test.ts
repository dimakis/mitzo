import { expect, it } from 'vitest';
import {
  assertSdkRepositoryCallback,
  createSdkRepositoryCallbacks,
} from '../sdk-repository-callback.js';
import {
  createSdkCallbackState,
  sdkCallbackOptions,
  SdkHookLifetime,
} from '../ordinary-local-vertex-sdk-query.js';

const name = 'mcp__mitzo-connections__PrepareLocalRepository';
function fixture() {
  let current = true;
  const callbacks = createSdkRepositoryCallbacks({
    commandId: () => 'original-command',
    checkTool: () => 'allow',
    assertCurrent() {
      if (!current) throw Error('Original query retired');
    },
  });
  const observe = (
    id: string,
    input: unknown = { path: '/offline/source', base: { kind: 'ref', ref: 'HEAD' } },
  ) =>
    callbacks.observe({
      hook_event_name: 'PreToolUse',
      session_id: '00000000-0000-4000-8000-000000000001',
      cwd: '/offline/original',
      tool_use_id: id,
      tool_name: name,
      tool_input: input,
    });
  const capture = (
    input: unknown = { base: { ref: 'HEAD', kind: 'ref' }, path: '/offline/source' },
  ) => callbacks.capture(name, input, 'mcp-request-1', new AbortController().signal);
  return {
    observe,
    capture,
    callbacks,
    retire: () => {
      current = false;
    },
  };
}

it('requires an actual original-query SDK pre-tool observation before binding a MCP callback', () => {
  const f = fixture();
  expect(() => f.capture()).toThrow();
  f.observe('actual-tool-use');
  const call = f.capture();
  expect(call).toMatchObject({
    commandId: 'original-command',
    toolUseId: 'actual-tool-use',
    mcpRequestId: 'mcp-request-1',
    sdkSessionId: '00000000-0000-4000-8000-000000000001',
    cwd: '/offline/original',
  });
  call.assertCurrent();
  expect(() => f.capture()).toThrow();
  f.retire();
  expect(() => call.assertCurrent()).toThrow('Original query retired');
});

it('refuses ambiguous identical parallel calls and changed inputs rather than guess a tool-use identity', () => {
  const f = fixture();
  f.observe('first');
  f.observe('second');
  expect(() => f.capture()).toThrow(/ambiguous/i);
  const g = fixture();
  g.observe('only');
  expect(() => g.capture({ path: '/offline/other' })).toThrow();
});

it('retains idempotent original hook identity but refuses rewritten tool inputs or missing MCP identity', () => {
  const f = fixture();
  f.observe('first');
  f.observe('first');
  expect(() =>
    f.callbacks.capture(
      name,
      { path: '/offline/source', base: { kind: 'ref', ref: 'HEAD' } },
      undefined,
      new AbortController().signal,
    ),
  ).toThrow();
  expect(() => f.observe('first', { path: '/offline/replaced' })).toThrow();
});

it('requires original factory provenance and the still-current frozen command tool ceiling', () => {
  let allowed = true;
  const f = createSdkRepositoryCallbacks({
    commandId: () => 'original-command',
    assertCurrent() {},
    checkTool: () => (allowed ? 'allow' : 'deny'),
  });
  const input = { path: '/offline/source' };
  f.observe({
    hook_event_name: 'PreToolUse',
    session_id: 'sdk-session',
    cwd: '/offline',
    tool_use_id: 'sdk-tool',
    tool_name: name,
    tool_input: input,
  });
  const controller = new AbortController();
  const call = f.capture(name, input, 42, controller.signal);
  assertSdkRepositoryCallback(call);
  expect(() => assertSdkRepositoryCallback({ ...call })).toThrow(
    /original SDK repository callback/i,
  );
  allowed = false;
  expect(() => call.assertCurrent()).toThrow(/ceiling/i);
  allowed = true;
  controller.abort();
  expect(() => call.assertCurrent()).toThrow();
});

it('captures the SDK hook through the actual query callback owner and refuses its retired lifetime', async () => {
  const state = createSdkCallbackState();
  state.bindCommandToolAuthority({ commandId: 'original-command', checkTool: () => 'allow' });
  const options = sdkCallbackOptions({}, new SdkHookLifetime(), () => state);
  const hook = options.hooks?.PreToolUse?.flatMap((entry) => entry.hooks)[0];
  expect(hook).toBeTypeOf('function');
  const data = {
    hook_event_name: 'PreToolUse' as const,
    session_id: '00000000-0000-4000-8000-000000000001',
    transcript_path: '/offline/synthetic-transcript',
    cwd: '/offline/original',
    tool_name: name,
    tool_use_id: 'actual-sdk-tool',
    tool_input: { path: '/offline/source' },
  };
  await hook!(data, 'hook-request', { signal: new AbortController().signal });
  const call = state.repositoryCallbacks.capture(
    name,
    data.tool_input,
    'mcp-request',
    new AbortController().signal,
  );
  expect(call.toolUseId).toBe('actual-sdk-tool');
  state.retired = true;
  expect(() => call.assertCurrent()).toThrow();
  await expect(
    hook!(data, 'old-hook-request', { signal: new AbortController().signal }),
  ).resolves.toMatchObject({ continue: false });
});
