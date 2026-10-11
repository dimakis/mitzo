import { describe, expect, it, vi } from 'vitest';
import { symposiumDispatchFixture as fixture } from './fixtures/symposium-dispatch.js';
import {
  admitSymposiumSharedDispatch,
  SymposiumSharedSeatExecutor,
  type OrdinarySymposiumTurn,
} from '../symposium-shared-execution.js';

describe('ordinary account execution through existing Symposium owners', () => {
  it('admits an ordinary account without requiring a native sandbox provider or saved recipe', () => {
    const f = fixture();
    expect(admitSymposiumSharedDispatch(f.deps, f.input)).toEqual(f.input.seat.accountBinding);
    expect(f.deps.hostGrants.verifySeat).toHaveBeenCalledWith({
      sessionId: 'parent',
      seat: f.input.seat,
      membershipGeneration: 1,
    });
  });

  it.each([
    'reviewer',
    'read-grant',
    'no-tools',
    'wrong-provenance',
    'stale-admission',
    'stopped',
    'dedicated-isolation',
  ])('rejects %s before ordinary dispatch', (caseName) => {
    const f = fixture();
    if (caseName === 'reviewer') f.input.seat.role = 'reviewer';
    if (caseName === 'read-grant')
      Object.assign(f.input.seat.authorityGrant!, { filesystem: 'read' });
    if (caseName === 'no-tools') Object.assign(f.input.seat.authorityGrant!, { tools: 'none' });
    if (caseName === 'wrong-provenance') f.input.provenance.configRevision = 3;
    if (caseName === 'stale-admission') f.deps.facts.getLatestSymposiumAdmission = () => null;
    if (caseName === 'stopped') f.controller.abort();
    if (caseName === 'dedicated-isolation')
      Object.assign(f.input.seat.isolationRequest!, { placement: 'dedicated' });
    expect(() => admitSymposiumSharedDispatch(f.deps, f.input)).toThrow();
  });

  it('resumes only the existing contributor thread and stamps provider acceptance through the claim owner', async () => {
    const f = fixture();
    f.input.providerThreadId = 'ordinary-child';
    const turn: OrdinarySymposiumTurn = {
      run: vi.fn(async (input, callbacks) => {
        callbacks.beforeDispatch();
        callbacks.accepted('ordinary-child', 'turn-2');
        return { providerThreadId: 'ordinary-child', content: 'Contribution.' };
      }),
      cancelAndDrain: vi.fn(async () => {}),
    };
    const openOrdinary = vi.fn(async () => turn);
    const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary });
    await expect(executor.execute(f.input)).resolves.toEqual({
      providerThreadId: 'ordinary-child',
      content: 'Contribution.',
    });
    expect(openOrdinary).toHaveBeenCalledWith({
      execution: f.input,
      binding: f.input.seat.accountBinding,
    });
    expect(f.deps.recordAccepted).toHaveBeenCalledWith(
      expect.objectContaining({
        claimToken: 'claim',
        providerThreadId: 'ordinary-child',
        providerTurnId: 'turn-2',
      }),
    );
  });

  it('rechecks authority at the provider boundary after async startup', async () => {
    const f = fixture();
    const run = vi.fn(async (_input, callbacks) => {
      f.config.revision++;
      callbacks.beforeDispatch();
      return { providerThreadId: 'child', content: 'invalid' };
    });
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({ run, cancelAndDrain: async () => {} }),
    });
    await expect(executor.execute(f.input)).rejects.toThrow(/configuration changed/);
  });

  it.each(['configuration', 'grant', 'delivery', 'stop'])(
    'fences %s changes while ordinary startup is pending before any provider dispatch',
    async (state) => {
      const f = fixture();
      let resolveOpen!: (turn: OrdinarySymposiumTurn) => void;
      const open = new Promise<OrdinarySymposiumTurn>((resolve) => {
        resolveOpen = resolve;
      });
      const dispatch = vi.fn();
      const run: OrdinarySymposiumTurn['run'] = vi.fn(async (_input, callbacks) => {
        callbacks.beforeDispatch();
        dispatch();
        callbacks.accepted('child', 'turn');
        return { providerThreadId: 'child', content: 'Contribution.' };
      });
      const cancelAndDrain = vi.fn(async () => {});
      const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary: () => open });
      const executing = executor.execute(f.input);
      const rejected = expect(executing).rejects.toThrow(
        state === 'configuration'
          ? 'Symposium configuration changed before native dispatch'
          : state === 'grant'
            ? 'host grant revoked'
            : state === 'delivery'
              ? 'Symposium recipient delivery changed before native dispatch'
              : 'Symposium ordinary attempt cancelled during startup',
      );
      if (state === 'configuration') f.config.revision++;
      if (state === 'grant')
        f.deps.hostGrants.verifySeat.mockImplementation(() => {
          throw new Error('host grant revoked');
        });
      if (state === 'delivery') f.deps.facts.getSymposiumDelivery = () => null;
      if (state === 'stop') f.controller.abort();
      const stopped =
        state === 'stop'
          ? executor.cancel({
              claimToken: f.input.claimToken,
              idempotencyKey: f.input.idempotencyKey,
            })
          : undefined;
      resolveOpen({ run, cancelAndDrain });
      await rejected;
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.deps.recordAccepted).not.toHaveBeenCalled();
      await (stopped ??
        executor.cancel({
          claimToken: f.input.claimToken,
          idempotencyKey: f.input.idempotencyKey,
        }));
      expect(cancelAndDrain).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['configuration', 'grant', 'delivery', 'stop'])(
    'rejects %s before opening an ordinary turn',
    async (state) => {
      const f = fixture();
      if (state === 'configuration') f.config.revision++;
      if (state === 'grant')
        f.deps.hostGrants.verifySeat.mockImplementation(() => {
          throw new Error('host grant revoked');
        });
      if (state === 'delivery') f.deps.facts.getSymposiumDelivery = () => null;
      if (state === 'stop') f.controller.abort(new Error('stopped'));
      const openOrdinary = vi.fn();
      const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary });
      await expect(executor.execute(f.input)).rejects.toThrow();
      expect(openOrdinary).not.toHaveBeenCalled();
    },
  );

  it('cannot complete a different thread or without an acceptance receipt', async () => {
    const f = fixture();
    f.input.providerThreadId = 'child';
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          callbacks.accepted('other-child', 'turn');
          return { providerThreadId: 'other-child', content: 'invalid' };
        },
        cancelAndDrain: async () => {},
      }),
    });
    await expect(executor.execute(f.input)).rejects.toThrow(/thread/);
    const missing = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({
        run: async (_input, callbacks) => {
          callbacks.beforeDispatch();
          return { providerThreadId: 'child', content: 'invalid' };
        },
        cancelAndDrain: async () => {},
      }),
    });
    await expect(missing.execute(f.input)).rejects.toThrow(/acceptance/);
  });

  it('Stop waits for startup and exact drain, preserving uncertainty on failed cleanup', async () => {
    const f = fixture();
    let resolveOpen!: (turn: OrdinarySymposiumTurn) => void;
    let resolveDrain!: () => void;
    const open = new Promise<OrdinarySymposiumTurn>((resolve) => {
      resolveOpen = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const run = vi.fn(async () => ({ providerThreadId: 'child', content: 'late' }));
    const cancelAndDrain = vi.fn(() => drained);
    const executor = new SymposiumSharedSeatExecutor({ ...f.deps, openOrdinary: () => open });
    const executing = executor.execute(f.input);
    const rejected = expect(executing).rejects.toThrow();
    const cancelled = executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' });
    let stopped = false;
    void cancelled.then(() => {
      stopped = true;
    });
    resolveOpen({ run, cancelAndDrain });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveDrain();
    await cancelled;
    await rejected;
    expect(run).not.toHaveBeenCalled();
    expect(cancelAndDrain).toHaveBeenCalledTimes(1);
    await expect(
      executor.cancel({ claimToken: 'unknown', idempotencyKey: 'recipient-key' }),
    ).rejects.toThrow('unknown exact attempt');
  });

  it('rejects duplicate active claims and cancellation targeting another recipient', async () => {
    const f = fixture();
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: () => new Promise(() => {}),
    });
    void executor.execute(f.input).catch(() => {});
    await expect(executor.execute(f.input)).rejects.toThrow(/already/);
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'another-recipient' }),
    ).rejects.toThrow(/identity/);
  });

  it('reobserves the same exact attempt after failed cleanup instead of caching uncertainty forever', async () => {
    const f = fixture();
    const cancelAndDrain = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal unconfirmed'))
      .mockResolvedValueOnce(undefined);
    const run = vi.fn(() => new Promise<never>(() => {}));
    const executor = new SymposiumSharedSeatExecutor({
      ...f.deps,
      openOrdinary: async () => ({ run, cancelAndDrain }),
    });
    void executor.execute(f.input).catch(() => {});
    await Promise.resolve();
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' }),
    ).rejects.toThrow('terminal unconfirmed');
    await expect(
      executor.cancel({ claimToken: 'claim', idempotencyKey: 'recipient-key' }),
    ).resolves.toBeUndefined();
    expect(cancelAndDrain).toHaveBeenCalledTimes(2);
  });
});
