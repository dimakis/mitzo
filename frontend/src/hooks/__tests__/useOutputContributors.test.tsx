// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
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
it('uses a fresh request identity for a new identical send after a confirmed receipt', async () => {
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
      return json({ delivery: { deliveryId: `delivery-${bodies.length}` }, contributor });
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
  await act(async () => result.current!.onSend('joe', 'Check again'));
  await waitFor(() => expect(result.current?.eligibility.available).toBe(true));
  await act(async () => result.current!.onSend('joe', 'Check again'));
  expect(bodies).toHaveLength(2);
  expect(bodies[0].requestId).not.toBe(bodies[1].requestId);
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
