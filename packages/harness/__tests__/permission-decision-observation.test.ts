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
  vi.restoreAllMocks();
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

  it.each([false, true])(
    'normalizes native one-shot approval before same-request observation and rechecks observer-side native revocation (revoke=%s)',
    async (revoke) => {
      const f = fixture();
      f.registry.setMode('client', 'ask');
      let nativeCurrent = true;
      const retained: Decision[] = [];
      const nativeAssertion = vi.fn(() => {
        if (!nativeCurrent) throw Error('Original native approval expired');
      });
      const lifecycle = vi.fn();
      cleanups.push(onPermissionLifecycle(lifecycle));
      const observer = vi.fn((decision: Decision) => {
        expect(nativeAssertion).toHaveBeenCalled();
        expect(f.sent.some((event) => event.type === 'permission_resolved')).toBe(false);
        retained.push(decision);
        if (revoke) nativeCurrent = false;
      });
      const pending = f.start(
        observer,
        { repo: { path: '/fixture/source' } },
        {
          nativeApproval: { assertCurrentSync: nativeAssertion },
          // Native one-shot normalization must precede the observer's snapshot.
          forcePrompt: false,
          allowSessionGrant: true,
          rememberSessionGrant: true,
          approvalScope: 'session',
        },
      );
      await Promise.resolve();
      const card = f.card();
      expect(card).toMatchObject({ approvalScope: 'request', allowSessionGrant: false });
      expect(JSON.parse(card.toolInput as string)).toEqual(pending.input);
      expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(
        true,
      );
      expect(await pending.result).toMatchObject({ behavior: revoke ? 'deny' : 'allow' });
      expect(observer).toHaveBeenCalledTimes(1);
      expect(retained).toHaveLength(1);
      expect(Object.isFrozen(retained[0])).toBe(true);
      expect(retained[0]).toMatchObject({
        input: pending.input,
        approvalScope: 'request',
        decisionClassification: 'user_temporary',
        inputSha256: createHash('sha256').update(JSON.stringify(pending.input)).digest('hex'),
      });
      expect(lifecycle).toHaveBeenLastCalledWith({
        type: 'resolved',
        permId: card.permId,
        resolution: revoke ? 'denied' : 'allowed',
      });
      expect(f.registry.get('client')!.sessionAllowList.size).toBe(0);
      expect(hasPending(card.permId as string)).toBe(false);
    },
  );

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

  it.each([
    'abort',
    'mode',
    'skill',
    'input',
    'session',
    'owner',
    'options',
    'callback',
    'signal',
    'toolUseID',
    'controlPlane',
    'expiry',
  ] as const)(
    'denies observer-side %s changes before any source effect while retaining observed evidence',
    async (change) => {
      const f = fixture();
      const sourceEffect = vi.fn();
      let retained: Decision | undefined;
      const observer = vi.fn((decision: Decision) => {
        retained = decision;
        if (change === 'abort') f.abort.abort();
        if (change === 'mode') f.registry.setMode('client', 'ask');
        if (change === 'skill') setSkillPolicy(f.registry, 'client', []);
        if (change === 'input') (pending.input.repo as { path: string }).path = '/different';
        if (change === 'session') f.registry.get('client')!.sessionId = 'different-session';
        if (change === 'owner') f.registry.abort('client');
        if (change === 'options') pending.options.approvalScope = 'session';
        if (change === 'callback') pending.options.onDecision = vi.fn();
        if (change === 'signal') pending.options.signal = new AbortController().signal;
        if (change === 'toolUseID') pending.options.toolUseID = 'different-tool-use';
        if (change === 'controlPlane') {
          pending.options.controlPlane = true;
          setSkillPolicy(f.registry, 'client', []);
        }
        if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(decision.expiresAt);
      });
      const pending = f.start(observer);
      const sourceOwner = pending.result.then((decision) => {
        if (decision.behavior === 'allow') sourceEffect();
        return decision;
      });
      await Promise.resolve();
      const card = f.card();
      const lifecycle = vi.fn();
      cleanups.push(onPermissionLifecycle(lifecycle));
      expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(
        true,
      );
      expect(await sourceOwner).toMatchObject({ behavior: 'deny' });
      expect(sourceEffect).not.toHaveBeenCalled();
      expect(observer).toHaveBeenCalledTimes(1);
      expect(retained).toMatchObject({
        permId: card.permId,
        input: { repo: { path: '/fixture/source' } },
      });
      expect(lifecycle).toHaveBeenLastCalledWith({
        type: 'resolved',
        permId: card.permId,
        resolution: change === 'expiry' ? 'expired' : 'denied',
      });
      expect(hasPending(card.permId as string)).toBe(false);
      expect(resolvePending(card.permId as string, 'once')).toBe(false);
    },
  );

  it('shows every exact Bash parameter on an observation card without changing ordinary Bash display', async () => {
    const f = fixture();
    const observer = vi.fn();
    const input = { command: 'echo offline-fixture', cwd: '/fixture/explicit-directory' };
    const pending = f.start(observer, input, {}, 'Bash');
    await Promise.resolve();
    const card = f.card();
    expect(JSON.parse(card.toolInput as string)).toEqual(input);
    expect(resolvePending(card.permId as string, 'once', undefined, 'original-session')).toBe(true);
    expect(await pending.result).toMatchObject({ behavior: 'allow', updatedInput: input });
    expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input }));
    const ordinary = buildPermissionHandler('client', f.registry)('Bash', input, {
      signal: f.abort.signal,
      toolUseID: 'ordinary-bash',
      forcePrompt: true,
    });
    await Promise.resolve();
    const ordinaryCard = f.sent.filter((event) => event.type === 'permission_request').at(-1)!;
    expect(ordinaryCard.toolInput).toBe(input.command);
    resolvePending(ordinaryCard.permId as string, 'deny', undefined, 'original-session');
    expect((await ordinary).behavior).toBe('deny');
  });

  it.each(['before-await', 'before-approval', 'observer'] as const)(
    'pins the checked Write boundary %s and prevents effects after path replacement',
    async (stage) => {
      const f = fixture();
      const session = f.registry.get('client')!;
      session.worktreePaths.set('repo', { path: '/fixture/allowed', wtId: 'original-custody' });
      const replace = () =>
        session.worktreePaths.set('repo', { path: '/fixture/replacement', wtId: 'new-custody' });
      const effect = vi.fn();
      const observer = vi.fn(() => {
        if (stage === 'observer') replace();
      });
      const input = { file_path: '/fixture/allowed/target.txt', content: 'offline reviewed bytes' };
      const pending = f.start(observer, input, {}, 'Write');
      const outcome = pending.result.then((result) => {
        if (result.behavior === 'allow') effect();
        return result;
      });
      if (stage === 'before-await') replace();
      await Promise.resolve();
      if (stage === 'before-await') expect(f.sent).toEqual([]);
      if (stage !== 'before-await') {
        const card = f.card();
        if (stage === 'before-approval') replace();
        resolvePending(card.permId as string, 'once', undefined, 'original-session');
      }
      expect((await outcome).behavior).toBe('deny');
      expect(effect).not.toHaveBeenCalled();
      expect(observer).toHaveBeenCalledTimes(stage === 'observer' ? 1 : 0);
      expect(getPendingRequestsBySession('original-session')).toEqual([]);
    },
  );

  it.each(['before-approval', 'observer'] as const)(
    'rejects every changed checked worktree/custody field %s',
    async (stage) => {
      for (const changed of [
        'clear',
        'add',
        'name',
        'wtId',
        'in-place-path',
        'session-wtId',
        'cwd',
        'primary-path',
      ] as const) {
        const f = fixture();
        const session = f.registry.get('client')!;
        session.worktreePaths.set('repo', { path: '/fixture/allowed', wtId: 'original-custody' });
        session.wtId = 'original-custody';
        session.cwd = '/fixture/allowed';
        session.worktreePath = '/fixture/allowed';
        const mutate = () => {
          if (changed === 'clear') session.worktreePaths.clear();
          if (changed === 'add')
            session.worktreePaths.set('extra-repo', {
              path: '/fixture/new-grant',
              wtId: 'new-custody',
            });
          if (changed === 'name') {
            const entry = session.worktreePaths.get('repo')!;
            session.worktreePaths.delete('repo');
            session.worktreePaths.set('renamed-repo', entry);
          }
          if (changed === 'wtId') session.worktreePaths.get('repo')!.wtId = 'replacement-custody';
          if (changed === 'in-place-path')
            session.worktreePaths.get('repo')!.path = '/fixture/replacement';
          if (changed === 'session-wtId') session.wtId = 'replacement-custody';
          if (changed === 'cwd') session.cwd = '/fixture/replacement';
          if (changed === 'primary-path') session.worktreePath = '/fixture/replacement';
        };
        const effect = vi.fn();
        let observed: Decision | undefined;
        const observer = vi.fn((decision: Decision) => {
          observed = decision;
          if (stage === 'observer') mutate();
        });
        const input = {
          file_path: '/fixture/allowed/target.txt',
          content: 'offline reviewed bytes',
        };
        const pending = f.start(observer, input, {}, 'Write');
        const outcome = pending.result.then((result) => {
          if (result.behavior === 'allow') effect();
          return result;
        });
        await Promise.resolve();
        const card = f.card();
        if (stage === 'before-approval') mutate();
        resolvePending(card.permId as string, 'once', undefined, 'original-session');
        expect((await outcome).behavior, changed).toBe('deny');
        expect(effect, changed).not.toHaveBeenCalled();
        expect(observer, changed).toHaveBeenCalledTimes(stage === 'observer' ? 1 : 0);
        if (stage === 'observer') expect(observed).toMatchObject({ permId: card.permId, input });
        expect(hasPending(card.permId as string)).toBe(false);
      }
    },
  );

  it.each(['before-await', 'before-approval', 'observer'] as const)(
    'rejects unsupported native source scope added %s',
    async (stage) => {
      const f = fixture();
      const effect = vi.fn();
      const nativeAssertion = vi.fn();
      const addScope = () => {
        pending.options.nativeSourceScope = {
          operatorId: 'replacement',
          assertCurrentSync: nativeAssertion,
        };
      };
      const observer = vi.fn(() => {
        if (stage === 'observer') addScope();
      });
      const pending = f.start(observer);
      const outcome = pending.result.then((result) => {
        if (result.behavior === 'allow') effect();
        return result;
      });
      if (stage === 'before-await') addScope();
      await Promise.resolve();
      if (stage === 'before-await') expect(f.sent).toEqual([]);
      if (stage !== 'before-await') {
        if (stage === 'before-approval') addScope();
        resolvePending(f.card().permId as string, 'once', undefined, 'original-session');
      }
      expect((await outcome).behavior).toBe('deny');
      expect(effect).not.toHaveBeenCalled();
      expect(nativeAssertion).not.toHaveBeenCalled();
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
