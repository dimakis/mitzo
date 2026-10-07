import { expect, it, vi } from 'vitest';
import { createCredentialConnectionTools } from '../credential-connection-tools.js';

function setup(stillAllowed: (name: string, method?: string) => boolean = () => true) {
  const service = {
    catalog: vi.fn(() => [
      {
        id: 'ha',
        label: 'Home Assistant',
        endpoint: 'https://ha.example.com',
        paths: ['/api/'],
        methods: ['GET'],
        revision: 1,
        access: 'approval_required',
      },
    ]),
    connection: vi.fn(() => ({
      id: 'ha',
      label: 'Home Assistant',
      endpoint: 'https://ha.example.com',
      paths: ['/api/'],
      methods: ['GET'],
      revision: 1,
    })),
    grant: vi.fn(),
    request: vi.fn(async () => ({ status: 200, body: 'ok' })),
  };
  const approve = vi.fn(
    async (_name: string, input: Record<string, unknown>, _options: unknown) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
  );
  const tools = createCredentialConnectionTools(
    service as never,
    'session-a',
    approve as never,
    stillAllowed,
  );
  return { service, approve, tools };
}
it('discovers metadata without prompting or reading credentials', async () => {
  const { tools, approve } = setup();
  const result = await tools.execute('ListConnections', {}, new AbortController().signal);
  expect(result?.content).toContain('Home Assistant');
  expect(approve).not.toHaveBeenCalled();
});
it('forces exact conversation approval before granting, even in auto mode', async () => {
  const { tools, approve, service } = setup();
  await tools.execute(
    'RequestConnectionAccess',
    { connectionId: 'ha' },
    new AbortController().signal,
  );
  expect(approve).toHaveBeenCalledWith(
    'RequestConnectionAccess',
    { connectionId: 'ha', revision: 1 },
    expect.objectContaining({ forcePrompt: true, approvalScope: 'conversation' }),
  );
  expect(service.grant).toHaveBeenCalledWith('session-a', 'ha', 1);
});
it('denial, cancellation or changed inputs never grants access', async () => {
  for (const outcome of [
    { behavior: 'deny', message: 'Denied' },
    { behavior: 'allow', updatedInput: { connectionId: 'other', revision: 1 } },
  ]) {
    const { tools, approve, service } = setup();
    approve.mockResolvedValueOnce(outcome as never);
    expect(
      (
        await tools.execute(
          'RequestConnectionAccess',
          { connectionId: 'ha' },
          new AbortController().signal,
        )
      )?.isError,
    ).toBe(true);
    expect(service.grant).not.toHaveBeenCalled();
  }
});
it('requires connection access before sending, rejects arbitrary secret and session fields', async () => {
  const { tools, service } = setup();
  expect(
    (
      await tools.execute(
        'ConnectionRequest',
        { connectionId: 'ha', path: '/api/', sessionId: 'other', secret: 'bad' },
        new AbortController().signal,
      )
    )?.isError,
  ).toBe(true);
  expect(service.request).not.toHaveBeenCalled();
  await tools.execute(
    'ConnectionRequest',
    { connectionId: 'ha', path: '/api/', method: 'GET' },
    new AbortController().signal,
  );
  expect(service.request).toHaveBeenCalledWith(
    'session-a',
    'ha',
    { path: '/api/', method: 'GET' },
    expect.any(AbortSignal),
    expect.any(Function),
  );
});

it('rechecks the method after approval and during secret resolution so Ask blocks pending writes', async () => {
  const { service, approve } = setup();
  service.connection.mockReturnValue({ ...service.connection(), methods: ['GET', 'POST'] });
  let mode = 'agent';
  const allowed = vi.fn(
    (_name: string, method?: string) =>
      mode !== 'ask' || !method || ['GET', 'HEAD'].includes(method),
  );
  const tools = createCredentialConnectionTools(service as never, 'a', approve as never, allowed);
  service.request.mockImplementationOnce(async (...args: unknown[]) => {
    mode = 'ask';
    const stillAllowed = args[4] as () => boolean;
    if (!stillAllowed()) throw new Error('mode changed');
    return { status: 200, body: 'should-not-be-sent' };
  });
  const result = await tools.execute(
    'ConnectionRequest',
    { connectionId: 'ha', path: '/api/', method: 'POST', body: '{}' },
    new AbortController().signal,
  );
  expect(result?.isError).toBe(true);
  expect(allowed).toHaveBeenLastCalledWith('ConnectionRequest', 'POST');
});

it('rejects paths, methods and read bodies outside configured scope before prompting', async () => {
  for (const request of [
    { path: '/outside/', method: 'GET' },
    { path: '//attacker.example/api/', method: 'GET' },
    { path: '/api/', method: 'POST' },
    { path: '/api/', method: 'GET', body: '{}' },
  ]) {
    const { tools, approve, service } = setup();
    expect(
      (
        await tools.execute(
          'ConnectionRequest',
          { connectionId: 'ha', ...request },
          new AbortController().signal,
        )
      )?.isError,
    ).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(service.grant).not.toHaveBeenCalled();
    expect(service.request).not.toHaveBeenCalled();
  }
});
it('rejects mutated approval input and cancellation without granting', async () => {
  for (const cancel of [false, true]) {
    const { tools, approve, service } = setup();
    const controller = new AbortController();
    approve.mockImplementationOnce(async (_name, input) => {
      if (cancel) controller.abort();
      else input.revision = 2;
      return { behavior: 'allow', updatedInput: input };
    });
    expect(
      (await tools.execute('RequestConnectionAccess', { connectionId: 'ha' }, controller.signal))
        ?.isError,
    ).toBe(true);
    expect(service.grant).not.toHaveBeenCalled();
  }
});
it('rechecks request policy immediately after approval before dispatch', async () => {
  let allowed = true;
  const { tools, approve, service } = setup((name) => name !== 'ConnectionRequest' || allowed);
  approve.mockImplementationOnce(async (_name, input) => {
    allowed = false;
    return { behavior: 'allow', updatedInput: input };
  });
  const result = await tools.execute(
    'ConnectionRequest',
    { connectionId: 'ha', path: '/api/' },
    new AbortController().signal,
  );
  expect(result?.isError).toBe(true);
  expect(service.request).not.toHaveBeenCalled();
});

it('does not grant if skill permission is withdrawn while approval is pending', async () => {
  let allowed = true;
  const { tools, approve, service } = setup(() => allowed);
  approve.mockImplementationOnce(async (_name, input) => {
    allowed = false;
    return { behavior: 'allow', updatedInput: input };
  });
  const result = await tools.execute(
    'RequestConnectionAccess',
    { connectionId: 'ha' },
    new AbortController().signal,
  );
  expect(result?.isError).toBe(true);
  expect(service.grant).not.toHaveBeenCalled();
});
