import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { SessionRegistry } from '../src/session-registry.js';
import { setSkillPolicy } from '../src/skill-policy.js';
import {
  getPendingRequestsBySession,
  hasPending,
  onPermissionLifecycle,
  resolvePending,
} from '../src/permissions.js';

type Handler = ReturnType<typeof buildPermissionHandler>;
type Options = Parameters<Handler>[2];
type Decision = Parameters<NonNullable<Options['onDecision']>>[0];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.useRealTimers();
});
function fixture() {
  const registry = new SessionRegistry();
  const abort = new AbortController();
  const sent: Record<string, unknown>[] = [];
  const transport = {
    isOpen: () => true,
    send: (event: Record<string, unknown>) => sent.push(event),
  };
  registry.register('client', {
    sessionId: 'original-session',
    mode: 'agent',
    sessionAllowList: new Set(),
    abortController: new AbortController(),
    transport,
  });
  cleanups.push(
    () => registry.dispose(),
    () => abort.abort(),
  );
  const handler = buildPermissionHandler('client', registry);
  const start = (
    onDecision: NonNullable<Options['onDecision']>,
    input: Record<string, unknown> = { repo: { path: '/fixture/source' } },
    overrides: Partial<Options> = {},
    toolName = 'PrepareLocalRepository',
  ) => {
    const options: Options = {
      signal: abort.signal,
      toolUseID: 'original-tool-use',
      forcePrompt: true,
      allowSessionGrant: false,
      rememberSessionGrant: false,
      approvalScope: 'request',
      onDecision,
      ...overrides,
    };
    return { result: handler(toolName, input, options), input, options };
  };
  const card = () => sent.find((event) => event.type === 'permission_request')!;
  return { registry, abort, sent, transport, start, card };
}

describe('private one-shot decision observation', () => {
  it('observes immutable original evidence once before outward allow and lifecycle', async () => {
    const f = fixture();
    const decisions: Decision[] = [];
    const order: string[] = [];
    cleanups.push(
      onPermissionLifecycle((event) => {
        if (event.type === 'resolved') order.push('lifecycle');
      }),
    );
    const input = { repo: { path: '/fixture/source' }, approval: 'forged-public-receipt' };
    const pending = f.start((decision) => {
      order.push('observed');
      expect(f.sent.some((event) => event.type === 'permission_resolved')).toBe(false);
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Object.isFrozen(decision.input)).toBe(true);
      expect(Object.isFrozen(decision.input.repo)).toBe(true);
      decisions.push(decision);
    }, input);
    await Promise.resolve();
    const card = f.card();
    expect(card).not.toHaveProperty('onDecision');
    expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(true);
    expect(order).toEqual(['observed', 'lifecycle']);
    expect(await pending.result).toMatchObject({ behavior: 'allow', updatedInput: input });
    expect(decisions).toEqual([
      {
        permId: card.permId,
        toolUseID: 'original-tool-use',
        sessionId: 'original-session',
        toolName: 'PrepareLocalRepository',
        input,
        inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        approvalScope: 'request',
        decisionClassification: 'user_temporary',
        expiresAt: card.expiresAt,
      },
    ]);
    expect(decisions[0].input).not.toBe(input);
    expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(
      false,
    );
    expect(decisions).toHaveLength(1);
    expect(hasPending(card.permId as string)).toBe(false);
  });

  it.each(['input', 'mode', 'skill', 'toolUseID', 'sessionId', 'callback', 'signal'] as const)(
    'rejects a changed %s before observation and settles the actual denial',
    async (change) => {
      const f = fixture();
      const observed = vi.fn();
      const detached = vi.spyOn(f.abort.signal, 'removeEventListener');
      const pending = f.start(observed);
      await Promise.resolve();
      const card = f.card();
      if (change === 'input') (pending.input.repo as { path: string }).path = '/different';
      if (change === 'mode') f.registry.setMode('client', 'ask');
      if (change === 'skill') setSkillPolicy(f.registry, 'client', []);
      if (change === 'toolUseID') pending.options.toolUseID = 'replacement-call';
      if (change === 'callback') pending.options.onDecision = vi.fn();
      if (change === 'signal') pending.options.signal = new AbortController().signal;
      if (change === 'sessionId') f.registry.get('client')!.sessionId = 'replacement-session';
      const lifecycle = vi.fn();
      cleanups.push(onPermissionLifecycle(lifecycle));
      expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(
        true,
      );
      expect(await pending.result).toMatchObject({ behavior: 'deny' });
      expect(observed).not.toHaveBeenCalled();
      expect(detached).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function));
      expect(lifecycle).toHaveBeenLastCalledWith({
        type: 'resolved',
        permId: card.permId,
        resolution: 'denied',
      });
    },
  );

  it('captures input before the first worktree await and never prompts with mutated input', async () => {
    const f = fixture();
    const observed = vi.fn();
    const pending = f.start(observed);
    (pending.input.repo as { path: string }).path = '/mutated-before-wait';
    expect(await pending.result).toMatchObject({ behavior: 'deny' });
    expect(f.sent).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });

  it.each(['throw', 'number', 'null', 'rejected-promise'] as const)(
    'settles denial when a synchronous observer produces %s',
    async (failure) => {
      const f = fixture();
      const observer = vi.fn(() => {
        if (failure === 'throw') throw Error('observation failed');
        if (failure === 'rejected-promise') return Promise.reject(Error('must be drained'));
        return failure === 'number' ? 1 : null;
      });
      const pending = f.start(observer);
      await Promise.resolve();
      const card = f.card();
      const lifecycle = vi.fn();
      cleanups.push(onPermissionLifecycle(lifecycle));
      expect(() =>
        resolvePending(card.permId as string, 'once', undefined, 'original-session'),
      ).not.toThrow();
      expect(await pending.result).toMatchObject({ behavior: 'deny' });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(lifecycle).toHaveBeenLastCalledWith({
        type: 'resolved',
        permId: card.permId,
        resolution: 'denied',
      });
      expect(hasPending(card.permId as string)).toBe(false);
      expect(resolvePending(card.permId as string, 'once')).toBe(false);
      await Promise.resolve();
    },
  );

  it.each(['abort', 'expiry', 'deny'] as const)('cleans up %s without evidence', async (ending) => {
    const f = fixture();
    const observed = vi.fn();
    const pending = f.start(observed);
    await Promise.resolve();
    const card = f.card();
    if (ending === 'abort') f.abort.abort();
    else if (ending === 'expiry') {
      vi.useFakeTimers();
      vi.setSystemTime(card.expiresAt as number);
      expect(resolvePending(card.permId as string, 'once')).toBe(false);
    } else resolvePending(card.permId as string, 'deny');
    expect(await pending.result).toMatchObject({ behavior: 'deny' });
    expect(observed).not.toHaveBeenCalled();
    expect(hasPending(card.permId as string)).toBe(false);
  });

  it('preserves original evidence through authenticated same-session reconnect replay', async () => {
    const f = fixture();
    const observer = vi.fn();
    const pending = f.start(observer);
    await Promise.resolve();
    const card = f.card();
    f.registry.detach('client');
    const replay = getPendingRequestsBySession('original-session');
    expect(replay).toHaveLength(1);
    expect(replay[0].permId).toBe(card.permId);
    const sent: Record<string, unknown>[] = [];
    f.registry.reattach('client', { isOpen: () => true, send: (event) => sent.push(event) });
    f.registry.rekey('client', 'reconnected');
    expect(resolvePending(card.permId as string, 'once', undefined, 'other-session')).toBe(false);
    expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(true);
    expect(await pending.result).toMatchObject({ behavior: 'allow' });
    expect(observer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        permId: card.permId,
        toolUseID: 'original-tool-use',
        sessionId: 'original-session',
      }),
    );
    expect(sent).toEqual([
      expect.objectContaining({ type: 'permission_resolved', permId: card.permId }),
    ]);
  });

  it('settles a synchronous requested-lifecycle approval without a late pending card or timer', async () => {
    const f = fixture();
    const observer = vi.fn();
    const resolutionErrors: unknown[] = [];
    const lifecycles: string[] = [];
    cleanups.push(
      onPermissionLifecycle((event) => {
        lifecycles.push(event.type);
        if (event.type === 'requested') {
          try {
            resolvePending(event.request.permId, 'once', undefined, 'original-session');
          } catch (error) {
            resolutionErrors.push(error);
          }
        }
      }),
    );
    const pending = f.start(observer);
    await Promise.resolve();
    expect(resolutionErrors).toEqual([]);
    expect(await pending.result).toMatchObject({ behavior: 'allow' });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(lifecycles).toEqual(['requested', 'resolved']);
    expect(f.sent).toEqual([expect.objectContaining({ type: 'permission_resolved' })]);
    expect(getPendingRequestsBySession('original-session')).toEqual([]);
  });

  it('leaves producer-owned committed evidence intact when observation commits then throws', async () => {
    const f = fixture();
    let retained: Decision | undefined;
    const observer = vi.fn((decision: Decision) => {
      retained = decision;
      throw Error('failure after durable existing-row commit');
    });
    const pending = f.start(observer);
    await Promise.resolve();
    const card = f.card();
    expect(resolvePending(card.permId as string, 'once')).toBe(true);
    expect(await pending.result).toMatchObject({ behavior: 'deny' });
    expect(retained).toMatchObject({ permId: card.permId, input: pending.input });
    expect(resolvePending(card.permId as string, 'once')).toBe(false);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('rejects observation before an on-demand worktree callback can run', async () => {
    const f = fixture();
    const onDemandCreate = vi.fn();
    const onDecision = vi.fn();
    const result = await buildPermissionHandler('client', f.registry, { onDemandCreate })(
      'PrepareLocalRepository',
      {},
      {
        signal: f.abort.signal,
        toolUseID: 'original-tool-use',
        forcePrompt: true,
        allowSessionGrant: false,
        rememberSessionGrant: false,
        approvalScope: 'request',
        onDecision,
      },
    );
    expect(result.behavior).toBe('deny');
    expect(onDemandCreate).not.toHaveBeenCalled();
    expect(onDecision).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it.each([
    { bad: undefined },
    { bad: NaN },
    { bad: Infinity },
    { bad: -0 },
    { bad: () => 'not JSON' },
    { bad: new Date() },
    { bad: { toJSON: () => 'forged serialization' } },
    { bad: Object.assign(Array<string>(2), { 1: 'hole' }) },
  ])('rejects lossy/nonplain observation input %j without prompting', async (input) => {
    const f = fixture();
    const observer = vi.fn();
    expect((await f.start(observer, input).result).behavior).toBe('deny');
    expect(observer).not.toHaveBeenCalled();
    expect(f.sent).toEqual([]);
  });

  it.each(['AskUserQuestion', 'TelosAdoptSource', 'TelosSaveArtifact'])(
    'rejects the unsupported %s observation path without changing its legacy behavior',
    async (toolName) => {
      const f = fixture();
      const observer = vi.fn();
      const pending = f.start(observer, {}, {}, toolName);
      expect((await pending.result).behavior).toBe('deny');
      expect(observer).not.toHaveBeenCalled();
      expect(f.sent).toEqual([]);
    },
  );

  it('never invokes input getters while capturing observation evidence', async () => {
    const f = fixture();
    const getter = vi.fn(() => '/private');
    const input = Object.defineProperty({}, 'path', { enumerable: true, get: getter });
    expect((await f.start(vi.fn(), input).result).behavior).toBe('deny');
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['auto', 'cache', 'permanent', 'session-scope'] as const)(
    'rejects unsupported observation on %s paths',
    async (path) => {
      const f = fixture();
      const observer = vi.fn();
      const overrides: Partial<Options> = {};
      let toolName = 'PrepareLocalRepository';
      if (path === 'auto') {
        overrides.forcePrompt = false;
        toolName = 'Read';
      }
      if (path === 'cache') {
        overrides.allowSessionGrant = true;
        f.registry.get('client')!.sessionAllowList.add(toolName);
      }
      if (path === 'session-scope') overrides.approvalScope = 'session';
      const pending = f.start(observer, {}, overrides, toolName);
      await Promise.resolve();
      if (path === 'permanent') resolvePending(f.card().permId as string, 'always');
      expect(await pending.result).toMatchObject({ behavior: 'deny' });
      expect(observer).not.toHaveBeenCalled();
    },
  );
});
