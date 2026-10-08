import { describe, expect, it, vi } from 'vitest';
import { ConnectionsService } from '../connections-service.js';
describe('OpenAI credential mutation admission', () => {
  it('blocks both admission paths while keys need attention, without starting a provider', async () => {
    const accountCredentialReady = vi.fn(async () => {
      throw new Error('OpenAI credentials need attention');
    });
    const service = new ConnectionsService({ list: () => [] } as never, {} as never, {
      accountCredentialReady,
    });
    const start = vi.fn(async () => 'started');
    await expect(service.withAccountRuntime('work', start)).rejects.toThrow('need attention');
    await expect(service.withAccountRuntimes('work', start)).rejects.toThrow('need attention');
    expect(start).not.toHaveBeenCalled();
  });
  it('serializes key replacement against sandbox admission using the existing control-plane gate', async () => {
    const service = new ConnectionsService({ list: () => [] } as never, {} as never);
    let release!: () => void;
    const mutation = service.withCredentialMutation(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const start = vi.fn(async () => 'started');
    const admission = service.withAccountRuntime('work', start);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    release();
    await mutation;
    expect(await admission).toBe('started');
  });
});
