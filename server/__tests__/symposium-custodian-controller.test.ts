import { expect, it, vi } from 'vitest';
import { SymposiumCustodianController } from '../symposium-custodian-controller.js';
function fixture() {
  const owner = {
    pause: vi.fn(),
    drain: vi.fn(async (_signal: AbortSignal) => {}),
    resume: vi.fn(),
    invalidate: vi.fn(),
    dispatch: vi.fn(async (_request: unknown, assert: () => void) => {
      assert();
      return { status: 200, body: { ok: true } };
    }),
  };
  return { owner, controller: new SymposiumCustodianController(owner) };
}
function request(epoch: number) {
  return {
    epoch,
    requestId: 'r1',
    operation: 'director.status',
    sessionId: 's1',
    body: {},
    query: {},
    authorization: { id: 'operator-jti', expiresAt: Date.now() + 60_000 },
  };
}
it('admits exactly one controller epoch and fences old requests before replacement', async () => {
  const { owner, controller } = fixture();
  const first = controller.attach();
  expect(() => controller.attach()).toThrow('active');
  await first.request(request(first.epoch));
  await first.lost();
  expect(owner.pause).toHaveBeenCalledOnce();
  expect(owner.drain).toHaveBeenCalledOnce();
  expect(owner.invalidate).toHaveBeenCalledWith('operator-jti');
  const second = controller.attach();
  expect(second.epoch).toBeGreaterThan(first.epoch);
  await expect(first.request(request(first.epoch))).rejects.toThrow('controller');
  await expect(second.request(request(first.epoch))).rejects.toThrow('epoch');
  await second.request(request(second.epoch));
});
it('does not admit replacement or report success while old physical cleanup is uncertain', async () => {
  const { owner, controller } = fixture();
  owner.drain.mockRejectedValue(Error('uncertain exact cleanup'));
  const first = controller.attach();
  await expect(first.lost()).rejects.toThrow('uncertain');
  expect(() => controller.attach()).toThrow('cleanup');
});
it('rejects expired and invalidated authentication and checks epoch after dispatch', async () => {
  const { owner, controller } = fixture();
  const first = controller.attach();
  const expired = request(first.epoch);
  expired.authorization.expiresAt = Date.now() - 1;
  await expect(first.request(expired)).rejects.toThrow('authorization');
  first.invalidate('operator-jti');
  await expect(first.request(request(first.epoch))).rejects.toThrow('authorization');
  expect(owner.dispatch).not.toHaveBeenCalled();
});
it('closes admission immediately even while an old semantic command is still completing', async () => {
  const { owner, controller } = fixture();
  let done!: () => void;
  owner.dispatch.mockImplementation(async (_request, assert) => {
    await new Promise<void>((resolve) => {
      done = resolve;
    });
    assert();
    return { status: 200, body: { ok: true } };
  });
  const first = controller.attach();
  const pending = first.request(request(first.epoch));
  const rejected = expect(pending).rejects.toThrow('controller');
  const lost = first.lost();
  expect(() => controller.attach()).toThrow();
  done();
  await rejected;
  await lost;
  expect(controller.attach().epoch).toBe(2);
});
