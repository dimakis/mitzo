import { expect, it, vi } from 'vitest';

vi.mock('../symposium-subscription-native.js', () => {
  throw new Error('native subscription adapter must not load for shared dispatch');
});
vi.mock('../symposium-orchestrator.js', () => {
  throw new Error('orchestrator runtime must not load for shared dispatch');
});
vi.mock('../account-profiles.js', () => {
  throw new Error('account profile runtime must not load for shared dispatch');
});
vi.mock('@mitzo/protocol', () => {
  throw new Error('protocol runtime must not load for shared dispatch');
});

it('loads ordinary shared execution independently of native routing and type-only runtime owners', async () => {
  const shared = await import('../symposium-shared-execution.js');
  expect(shared.SymposiumSharedSeatExecutor).toBeTypeOf('function');
  expect(shared.admitSymposiumSharedDispatch).toBeTypeOf('function');
});
