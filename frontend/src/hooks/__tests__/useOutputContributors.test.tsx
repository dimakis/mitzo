// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { useOutputContributors } from '../useOutputContributors';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const source = {
  messageId: 'draft-message',
  blockId: 'draft-block',
  messageEndSeq: 4,
  sha256: 'a'.repeat(64),
};
const output = {
  outputId: '6f84c6cb-3ec4-4f45-bb2e-761119e02231',
  sessionId: 'source',
  title: 'Draft',
  revision: 1,
  kind: 'inline_draft',
  durability: 'reference_registered',
  label: 'In conversation',
  sourceAvailability: 'available',
  source: { sessionId: 'source', ...source },
  provenance: null,
  createdAt: 1,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function reads(path: string) {
  if (path.endsWith('/contributors'))
    return json({
      contributors: [],
      eligibility: { available: true, reason: 'Ordinary route', accountIds: ['personal'] },
    });
  if (path.endsWith('/outputs'))
    return json({ outputs: [output], candidates: [{ source, content: 'Exact draft' }] });
  return json({ output, content: 'Exact draft', contextPackageDigest: 'b'.repeat(64) });
}
it('starts no work on an empty or disabled chat', () => {
  const { result, rerender } = renderHook(({ id, enabled }) => useOutputContributors(id, enabled), {
    initialProps: { id: null as string | null, enabled: true },
  });
  expect(result.current).toBeNull();
  rerender({ id: 'symposium', enabled: false });
  expect(result.current).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});
it('loads the exact registered reference and trusted contributor eligibility without a mutation', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => reads(String(url)));
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected?.content).toBe('Exact draft'));
  expect(result.current?.selected?.contextPackageDigest).toBe('b'.repeat(64));
  expect(result.current?.eligibility.accountIds).toEqual(['personal']);
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});
it('retries an uncertain registration with the same request identity and exact finalized source', async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      throw Error('Response lost');
    }
    return reads(String(url));
  });
  const mounted = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(mounted.result.current?.selected).toBeTruthy());
  await act(async () => {
    await expect(
      mounted.result.current!.onRegister({ source, content: 'Exact draft' }, 'Draft'),
    ).rejects.toThrow('Response lost');
  });
  mounted.unmount();
  const next = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(next.result.current?.selected).toBeTruthy());
  await act(async () => {
    await expect(
      next.result.current!.onRegister({ source, content: 'Exact draft' }, 'Draft'),
    ).rejects.toThrow('Response lost');
  });
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({ title: 'Draft', source, requestId: expect.any(String) });
  expect(JSON.stringify(sessionStorage)).not.toContain('Exact draft');
});
it('never applies a retired conversation read to the new chat', async () => {
  let release!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url) === '/api/sessions/old/outputs'
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : json({ outputs: [], candidates: [] }),
  );
  const { result, rerender } = renderHook(({ id }) => useOutputContributors(id, true), {
    initialProps: { id: 'old' },
  });
  rerender({ id: 'new' });
  await waitFor(() => expect(result.current?.loading).toBe(false));
  await act(async () =>
    release(
      json({
        outputs: [{ ...output, sessionId: 'old', source: { ...output.source, sessionId: 'old' } }],
        candidates: [],
      }),
    ),
  );
  expect(result.current?.sessionId).toBe('new');
  expect(result.current?.outputs).toEqual([]);
  expect(result.current?.selected).toBeNull();
});
it('keeps the source output visible but disables execution when access refresh fails', async () => {
  let fail = false;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    fail && String(url).endsWith('/contributors')
      ? json({ error: 'Access unavailable' }, 503)
      : reads(String(url)),
  );
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected?.content).toBe('Exact draft'));
  fail = true;
  act(() => result.current!.onRefresh());
  await waitFor(() => expect(result.current?.error).toContain('Access unavailable'));
  expect(result.current?.eligibility.available).not.toBe(true);
  expect(result.current?.selected?.content).toBe('Exact draft');
});
it('never accepts a cached context digest for contributor creation after the selected-output read fails', async () => {
  let failed = false;
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    failed && String(url).endsWith(`/outputs/${output.outputId}`)
      ? json({ error: 'Selected draft unavailable' }, 503)
      : reads(String(url)),
  );
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected?.content).toBe('Exact draft'));
  failed = true;
  act(() => result.current!.onRefresh());
  await waitFor(() => expect(result.current?.selected?.contextPackageDigest).toBeNull());
  await act(async () => {
    await expect(
      result.current!.onAdd({
        label: 'Joe',
        accountId: 'personal',
        model: 'luna-fixture',
        instructions: 'Draft guidance',
        mode: 'ask',
        outputId: output.outputId,
        outputRevision: 1,
        contextPackageDigest: 'b'.repeat(64),
      }),
    ).rejects.toThrow('selected draft or account access has changed');
  });
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it.each(['delivered', 'failed'])(
  'uses a fresh request identity for a new identical send after a confirmed %s receipt',
  async (status) => {
    const contributor = {
      id: 'joe',
      label: 'Joe',
      accountLabel: 'Personal ChatGPT',
      model: 'luna-fixture',
      sessionId: 'child',
      status: 'idle',
      outputId: output.outputId,
      outputRevision: 1,
      messages: [],
    };
    const bodies: Record<string, unknown>[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(init.body as string));
        return json({ delivery: { deliveryId: `delivery-${bodies.length}`, status }, contributor });
      }
      if (String(url).endsWith('/contributors'))
        return json({
          contributors: [contributor],
          eligibility: { available: true, accountIds: ['personal'], reason: 'Ordinary route' },
        });
      return reads(String(url));
    });
    const { result } = renderHook(() => useOutputContributors('source', true));
    await waitFor(() => expect(result.current?.selected).toBeTruthy());
    await act(async () => {
      const send = result.current!.onSend('joe', 'Check again');
      if (status === 'failed') await expect(send).rejects.toThrow('Your draft is preserved');
      else await expect(send).resolves.toBeUndefined();
    });
    await waitFor(() => expect(result.current?.eligibility.available).toBe(true));
    await act(async () => {
      const send = result.current!.onSend('joe', 'Check again');
      if (status === 'failed') await expect(send).rejects.toThrow('Your draft is preserved');
      else await expect(send).resolves.toBeUndefined();
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].requestId).not.toBe(bodies[1].requestId);
  },
);
it('keeps an uncertain send identity despite an idle snapshot, then retires its exact failed receipt', async () => {
  const contributor = {
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child',
    status: 'idle',
    outputId: output.outputId,
    outputRevision: 1,
    messages: [],
  };
  const bodies: Record<string, unknown>[] = [];
  let contributorReads = 0;
  const retryIds = () =>
    Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.getItem(sessionStorage.key(index)!),
    );
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      if (bodies.length === 1) return json({ error: 'Receipt unavailable' }, 503);
      return json({
        delivery: {
          deliveryId: bodies.length === 2 ? 'confirmed-failed' : 'fresh-delivery',
          status: bodies.length === 2 ? 'failed' : 'delivered',
        },
        contributor,
      });
    }
    if (String(url).endsWith('/contributors')) {
      contributorReads++;
      return json({
        contributors: [contributor],
        eligibility: { available: true, accountIds: ['personal'], reason: 'Ordinary route' },
      });
    }
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  await act(async () => {
    await expect(result.current!.onSend('joe', 'Check again')).rejects.toThrow(
      'Receipt unavailable',
    );
  });
  expect(retryIds()).toContain(bodies[0].requestId);
  act(() => result.current!.onRefresh());
  await waitFor(() => expect(contributorReads).toBeGreaterThan(1));
  expect(result.current!.contributors[0].status).toBe('idle');
  expect(retryIds()).toContain(bodies[0].requestId);
  await act(async () => {
    await expect(result.current!.onSend('joe', 'Check again')).rejects.toThrow(
      'Your draft is preserved',
    );
  });
  expect(bodies[1].requestId).toBe(bodies[0].requestId);
  expect(retryIds()).not.toContain(bodies[0].requestId);
  await act(async () => {
    await result.current!.onSend('joe', 'Check again');
  });
  expect(bodies).toHaveLength(3);
  expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
  expect(bodies.map(({ text }) => text)).toEqual(['Check again', 'Check again', 'Check again']);
});

it('allows a fresh follow-up after authoritative idle despite a historically failed delivery, but refuses uncertain cleanup', async () => {
  const messages = [
    {
      messageId: 'prior-reply',
      role: 'assistant',
      startedSeq: 8,
      blocks: [{ blockId: 'prior-text', blockType: 'text', content: 'Retained attributed reply' }],
    },
  ];
  let status = 'idle';
  const contributor = () => ({
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child',
    status,
    outputId: output.outputId,
    outputRevision: 1,
    messages,
  });
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      if (bodies.length === 1) {
        status = 'unavailable';
        return json({
          delivery: {
            deliveryId: 'historical-failed-delivery',
            status: 'failed',
            recipients: [
              {
                error: 'Provider diagnostic containing a private callback detail',
              },
            ],
          },
          contributor: contributor(),
        });
      }
      return json({
        delivery: { deliveryId: 'new-delivery', status: 'delivered' },
        contributor: contributor(),
      });
    }
    if (String(url).endsWith('/contributors'))
      return json({
        contributors: [contributor()],
        eligibility: { available: true, accountIds: ['personal'], reason: 'Ordinary route' },
      });
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  await act(async () => {
    await expect(result.current!.onSend('joe', 'Failed turn')).rejects.toThrow(
      'Contributor execution failed. Your draft is preserved. Check its conversation and current account before retrying.',
    );
  });
  await waitFor(() => expect(result.current?.contributors[0].status).toBe('unavailable'));
  await act(async () => {
    await expect(result.current!.onSend('joe', 'Fresh follow-up')).rejects.toThrow('unavailable');
  });
  expect(bodies).toHaveLength(1);
  status = 'idle';
  act(() => result.current!.onRefresh());
  await waitFor(() => expect(result.current?.contributors[0].status).toBe('idle'));
  expect(result.current?.contributors[0].messages).toEqual(messages);
  await act(async () => result.current!.onSend('joe', 'Failed turn'));
  expect(bodies).toHaveLength(2);
  expect(bodies[1].text).toBe('Failed turn');
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  expect(result.current?.contributors[0].messages).toEqual(messages);
});
it('retains the exact send request identity when the transport outcome is unknown', async () => {
  const contributor = {
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child',
    status: 'idle',
    outputId: output.outputId,
    outputRevision: 1,
    messages: [],
  };
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      throw Error('Response lost');
    }
    if (String(url).endsWith('/contributors'))
      return json({
        contributors: [contributor],
        eligibility: { available: true, accountIds: ['personal'], reason: 'Ordinary route' },
      });
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  for (let retry = 0; retry < 2; retry++)
    await act(async () => {
      await expect(result.current!.onSend('joe', 'Uncertain turn')).rejects.toThrow(
        'Response lost',
      );
    });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(JSON.stringify(sessionStorage)).not.toContain('Uncertain turn');
});
it('accepts a matching terminal Stop receipt after the account becomes unavailable', async () => {
  const contributor = {
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child',
    status: 'running',
    outputId: output.outputId,
    outputRevision: 1,
    messages: [],
  };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST')
      return json({ contributor: { ...contributor, status: 'unavailable' } });
    if (String(url).endsWith('/contributors'))
      return json({
        contributors: [contributor],
        eligibility: { available: false, accountIds: [], reason: 'Account unavailable' },
      });
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  await act(async () => {
    await expect(result.current!.onStop('joe')).resolves.toBeUndefined();
  });
});
it.each([
  { id: 'joe', status: 'running' },
  { id: 'another-contributor', status: 'unavailable' },
])('retains the Stop retry identity for an unconfirmed receipt (%s)', async (receipt) => {
  const contributor = {
    id: 'joe',
    label: 'Joe',
    accountLabel: 'Personal ChatGPT',
    model: 'luna-fixture',
    sessionId: 'child',
    status: 'running',
    outputId: output.outputId,
    outputRevision: 1,
    messages: [],
  };
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      return json({ contributor: { ...contributor, ...receipt } });
    }
    if (String(url).endsWith('/contributors'))
      return json({
        contributors: [contributor],
        eligibility: { available: false, accountIds: [], reason: 'Account unavailable' },
      });
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source', true));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  for (let attempt = 0; attempt < 2; attempt++)
    await act(async () => {
      await expect(result.current!.onStop('joe')).rejects.toThrow('did not confirm');
    });
  expect(bodies[0].requestId).toBe(bodies[1].requestId);
});

it.each(['register', 'add', 'send', 'stop'] as const)(
  'retains exact %s request identities across HTTP retries, retiring only confirmed receipts',
  async (operation) => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const contributor = {
      id: 'joe',
      label: 'Joe',
      accountLabel: 'Personal',
      model: 'fixture',
      sessionId: 'child',
      status: 'idle',
      outputId: output.outputId,
      outputRevision: 1,
    };
    const input = {
      accountId: 'personal',
      model: 'fixture',
      label: 'Joe',
      instructions: 'Unicode café\r\n🧭',
      mode: 'agent' as const,
      outputId: output.outputId,
      outputRevision: 1,
      contextPackageDigest: 'b'.repeat(64),
    };
    const candidate = { source, content: 'Exact draft' };
    const payload =
      operation === 'register'
        ? { title: 'Draft', source }
        : operation === 'add'
          ? input
          : operation === 'send'
            ? { text: input.instructions }
            : {};
    const canonical = (value: unknown): string =>
      value && typeof value === 'object'
        ? `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
            .join(',')}}`
        : JSON.stringify(value);
    const expectedHash = createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
    const bodies: Record<string, unknown>[] = [];
    let confirmed = false;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(init.body as string));
        if (!confirmed) throw Error('Response lost');
        return json(
          operation === 'register'
            ? { output }
            : operation === 'send'
              ? { contributor, delivery: { deliveryId: 'delivered', status: 'delivered' } }
              : { contributor },
        );
      }
      if (String(url).endsWith('/contributors'))
        return json({
          contributors: [contributor],
          eligibility: { available: true, reason: 'Ordinary route', accountIds: ['personal'] },
        });
      return reads(String(url));
    });
    const invoke = (props: NonNullable<ReturnType<typeof useOutputContributors>>) =>
      operation === 'register'
        ? props.onRegister(candidate, 'Draft')
        : operation === 'add'
          ? props.onAdd(input)
          : operation === 'send'
            ? props.onSend('joe', input.instructions)
            : props.onStop('joe');
    const mounted = renderHook(() => useOutputContributors('source'));
    await waitFor(() =>
      expect(mounted.result.current?.selected?.contextPackageDigest).toBeTruthy(),
    );
    await act(async () => {
      await expect(invoke(mounted.result.current!)).rejects.toThrow('Response lost');
    });
    const key = `mitzo-output-request:source:${operation === 'send' || operation === 'stop' ? `${operation}:joe` : operation}:${expectedHash}`;
    expect(sessionStorage.getItem(key)).toBe(bodies[0].requestId);
    expect(bodies[0].requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(bodies[0]).toEqual({ ...payload, requestId: bodies[0].requestId });
    mounted.unmount();
    const next = renderHook(() => useOutputContributors('source'));
    await waitFor(() => expect(next.result.current?.selected?.contextPackageDigest).toBeTruthy());
    await act(async () => {
      await expect(invoke(next.result.current!)).rejects.toThrow('Response lost');
    });
    expect(bodies[1]).toEqual(bodies[0]);
    confirmed = true;
    await act(async () => {
      await invoke(next.result.current!);
    });
    expect(bodies[2]).toEqual(bodies[0]);
    expect(sessionStorage.getItem(key)).toBeNull();
    await waitFor(() => expect(next.result.current?.loading).toBe(false));
    await act(async () => {
      await invoke(next.result.current!);
    });
    expect(bodies[3].requestId).not.toBe(bodies[0].requestId);
    expect(sessionStorage.length).toBe(0);
  },
);

it('keeps HTTP Add retries bound to the exact selected revision and context package', async () => {
  vi.stubGlobal('crypto', undefined);
  const bodies: Record<string, unknown>[] = [];
  let digest = 'b'.repeat(64);
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      throw Error('Response lost');
    }
    if (String(url).endsWith(output.outputId))
      return json({ output, content: 'Exact draft', contextPackageDigest: digest });
    return reads(String(url));
  });
  const input = {
    accountId: 'personal',
    model: 'fixture',
    label: 'Joe',
    instructions: 'Private guidance',
    mode: 'agent' as const,
    outputId: output.outputId,
    outputRevision: 1,
    contextPackageDigest: digest,
  };
  const { result } = renderHook(() => useOutputContributors('source'));
  await waitFor(() => expect(result.current?.selected?.contextPackageDigest).toBe(digest));
  await act(async () => {
    await expect(result.current!.onAdd(input)).rejects.toThrow('Response lost');
  });
  await act(async () => {
    await expect(result.current!.onAdd({ ...input, outputRevision: 2 })).rejects.toThrow(
      'selected draft or account access has changed',
    );
  });
  expect(bodies).toHaveLength(1);
  digest = 'c'.repeat(64);
  act(() => result.current!.onRefresh());
  await waitFor(() => expect(result.current?.selected?.contextPackageDigest).toBe(digest));
  await act(async () => {
    await expect(result.current!.onAdd(input)).rejects.toThrow(
      'selected draft or account access has changed',
    );
  });
  expect(bodies).toHaveLength(1);
  const changed = { ...input, contextPackageDigest: digest };
  await act(async () => {
    await expect(result.current!.onAdd(changed)).rejects.toThrow('Response lost');
  });
  await act(async () => {
    await expect(result.current!.onAdd(changed)).rejects.toThrow('Response lost');
  });
  expect(bodies[1]).toEqual(bodies[2]);
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  expect(bodies[0]).toEqual({ ...input, requestId: bodies[0].requestId });
  expect(bodies[1]).toEqual({ ...changed, requestId: bodies[1].requestId });
  expect(JSON.stringify(sessionStorage)).not.toContain(input.instructions);
});
it('does not accept a different source receipt for an HTTP registration retry', async () => {
  vi.stubGlobal('crypto', undefined);
  const bodies: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body as string));
      return json({ output });
    }
    return reads(String(url));
  });
  const { result } = renderHook(() => useOutputContributors('source'));
  await waitFor(() => expect(result.current?.selected).toBeTruthy());
  const candidate = {
    source: { ...source, messageEndSeq: 5, sha256: 'c'.repeat(64) },
    content: 'A newer finalized source',
  };
  for (let i = 0; i < 2; i++)
    await act(async () => {
      await expect(result.current!.onRegister(candidate, 'Draft')).rejects.toThrow(
        'did not confirm this request',
      );
    });
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toEqual({
    source: candidate.source,
    title: 'Draft',
    requestId: bodies[0].requestId,
  });
  expect(sessionStorage.length).toBe(1);
  await act(async () => {
    await result.current!.onRegister({ source, content: 'Exact draft' }, 'Draft');
  });
  expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
  expect(sessionStorage.length).toBe(1);
});
