import { expect, it, vi } from 'vitest';
import { ConnectionsService } from '../connections-service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(ready = vi.fn(async (_id: string, _signal: AbortSignal) => {})) {
  return {
    ready,
    service: new ConnectionsService({ list: () => [] } as never, {} as never, {
      accountCredentialReady: ready,
    }),
  };
}
const signal = () => new AbortController().signal;

it('checks fresh readiness inside both runtime reservation paths', async () => {
  const { service, ready } = fixture();
  await service.withAccountRuntime('work', async () => {
    await service.assertAccountCredentialReady('work', signal());
  });
  await service.withAccountRuntimes('work', async () => {
    await service.assertAccountCredentialReady('work', signal());
  });
  expect(ready).toHaveBeenCalledTimes(4);
});

it('keeps credential mutations queued while nested readiness runs', async () => {
  const { service } = fixture();
  const entered = deferred();
  const finish = deferred();
  const startup = service.withAccountRuntimes('work', async () => {
    await service.assertAccountCredentialReady('work', signal());
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const mutate = vi.fn(async () => {});
  const mutation = service.withCredentialMutation(mutate);
  await Promise.resolve();
  expect(mutate).not.toHaveBeenCalled();
  finish.resolve();
  await startup;
  await mutation;
  expect(mutate).toHaveBeenCalledOnce();
});

it('waits for an unrelated credential mutation before observing readiness', async () => {
  const { service, ready } = fixture();
  const entered = deferred();
  const finish = deferred();
  const mutation = service.withCredentialMutation(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const observation = service.assertAccountCredentialReady('work', signal());
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  finish.resolve();
  await mutation;
  await observation;
  expect(ready).toHaveBeenCalledOnce();
});

it('propagates failed readiness and releases the reservation for subsequent work', async () => {
  const { service, ready } = fixture();
  ready.mockResolvedValueOnce().mockRejectedValueOnce(Error('unresolved rotation'));
  await expect(
    service.withAccountRuntimes('work', () =>
      service.assertAccountCredentialReady('work', signal()),
    ),
  ).rejects.toThrow('unresolved rotation');
  const next = vi.fn(async () => {});
  await service.withCredentialMutation(next);
  expect(next).toHaveBeenCalledOnce();
});

it('checks cancellation before and after readiness without reading a key', async () => {
  const { service, ready } = fixture();
  const aborted = AbortSignal.abort();
  await expect(service.assertAccountCredentialReady('work', aborted)).rejects.toThrow();
  expect(ready).not.toHaveBeenCalled();
  const controller = new AbortController();
  ready.mockImplementationOnce(async () => {
    controller.abort();
  });
  await expect(service.assertAccountCredentialReady('work', controller.signal)).rejects.toThrow();
});

it('expires inherited async reservations before later credential work', async () => {
  const { service, ready } = fixture();
  const resume = deferred();
  let descendant!: Promise<void>;
  await service.withAccountRuntimes('work', async () => {
    descendant = resume.promise.then(() => service.assertAccountCredentialReady('work', signal()));
  });
  ready.mockClear();
  const entered = deferred();
  const finish = deferred();
  const mutation = service.withCredentialMutation(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  resume.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(ready).not.toHaveBeenCalled();
  finish.resolve();
  await mutation;
  await descendant;
  expect(ready).toHaveBeenCalledOnce();
});

it('never reenters credential mutation from the same active reservation', async () => {
  const { service } = fixture();
  const mutate = vi.fn(async () => {});
  let mutation!: Promise<void>;
  await service.withAccountRuntimes('work', async () => {
    mutation = service.withCredentialMutation(mutate);
    await expect(mutation).rejects.toThrow('mutation cannot reenter');
    await service.assertAccountCredentialReady('work', signal());
    expect(mutate).not.toHaveBeenCalled();
  });
  await expect(mutation).rejects.toThrow('mutation cannot reenter');
  expect(mutate).not.toHaveBeenCalled();
});

it('refuses explicit credential checks without a configured controller', async () => {
  const service = new ConnectionsService({ list: () => [] } as never, {} as never);
  await expect(service.assertAccountCredentialReady('work', signal())).rejects.toThrow(
    'controller unavailable',
  );
});
