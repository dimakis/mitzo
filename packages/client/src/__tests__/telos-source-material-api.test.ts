import { expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';

const input = {
  sessionId: 'planning',
  toolUseId: 'tool:exact/one',
  proposalSha256: 'a'.repeat(64),
  after: { createdAt: '2026-10-17T00:00:00.000Z', artifactId: 'retained/id', revision: 100 },
};
const response = {
  permId: 'permission',
  sessionId: input.sessionId,
  toolUseId: input.toolUseId,
  proposalSha256: input.proposalSha256,
  artifacts: [
    {
      artifactId: 'material',
      revision: 150,
      sha256: 'b'.repeat(64),
      title: 'Earlier exact revision',
      filename: 'plan.md',
      sizeBytes: 20,
      createdAt: input.after.createdAt,
      sessionId: input.sessionId,
    },
  ],
  cursor: { ...input.after, artifactId: 'material', revision: 150 },
  hasMore: false,
};
it('passes independent material cursor/invocation proof and abort signal through the protected read', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  const controller = new AbortController();
  const result = await new TelosWorkApiClient(fetch).getSourceMaterials(
    'permission',
    input,
    controller.signal,
  );
  expect(result).toEqual(response);
  const url = new URL(fetch.mock.calls[0][0], 'https://mitzo-ui.test');
  expect(url.pathname).toBe('/api/telos/work/source/permissions/permission/materials');
  expect(url.searchParams.get('sessionId')).toBe(input.sessionId);
  expect(url.searchParams.get('toolUseId')).toBe(input.toolUseId);
  expect(url.searchParams.get('proposalSha256')).toBe(input.proposalSha256);
  expect(JSON.parse(url.searchParams.get('after')!)).toEqual(input.after);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    credentials: 'include',
    signal: controller.signal,
  });
});
it('refuses malformed cursor before fetching and rejects returned bytes or excess rows', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
  const client = new TelosWorkApiClient(fetch);
  await expect(
    Promise.resolve().then(() =>
      client.getSourceMaterials('permission', { ...input, after: { ...input.after, revision: 0 } }),
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...response,
        artifacts: [{ ...response.artifacts[0], contentBase64: 'PRIVATE' }],
      }),
    ),
  );
  await expect(client.getSourceMaterials('permission', input)).rejects.toThrow();
  fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ...response,
        artifacts: Array.from({ length: 101 }, () => response.artifacts[0]),
      }),
    ),
  );
  await expect(client.getSourceMaterials('permission', input)).rejects.toThrow();
});
