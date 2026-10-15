import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeTelosArtifactTool,
  telosArtifactDefinitions,
  TelosSaveArtifactInput,
  TELOS_ARTIFACT_INSTRUCTIONS,
  telosArtifactInstructions,
} from '../telos-artifact-tools.js';
afterEach(() => vi.unstubAllGlobals());
describe('Telos artifact tool contract', () => {
  it.each([false, true])('retrieves history only when relevant (recipe=%s)', (recipe) => {
    const instructions = telosArtifactInstructions(recipe);
    expect(instructions).not.toContain('At cold start');
    expect(instructions).toContain('When prior task history is relevant');
    expect(instructions).toContain('not a prerequisite');
    expect(instructions).toContain('does not require a new Telos outcome');
  });
  it('advertises save, find and read and teaches durable receipt-driven handovers', () => {
    expect(telosArtifactDefinitions.map((d) => d.name)).toEqual([
      'TelosSaveArtifact',
      'TelosFindArtifacts',
      'TelosReadArtifact',
    ]);
    expect(TELOS_ARTIFACT_INSTRUCTIONS).toContain('TelosUpdateItem');
    expect(TELOS_ARTIFACT_INSTRUCTIONS).toContain('before handover');
    expect(TELOS_ARTIFACT_INSTRUCTIONS).toContain('TelosFindArtifacts');
    expect(TELOS_ARTIFACT_INSTRUCTIONS).toContain('sandbox-local');
  });
  it('validates exactly one of a workspace file path or inline text before calling the host', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      TelosSaveArtifactInput.safeParse({
        requestId: 'save-spec',
        itemId: 't',
        filename: 's.md',
        title: 'Spec',
        content: 'text',
        path: '/spec.md',
      }).success,
    ).toBe(false);
    const result = await executeTelosArtifactTool(
      'http://host',
      'client',
      'token',
      'TelosSaveArtifact',
      { requestId: 'save-spec', itemId: 't', filename: '../s.md', title: 'Spec', content: 'text' },
    );
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses host authentication, propagates receipts and errors, and never treats a failure as saved', async () => {
    const receipt = {
      id: 'artifact',
      revision: 1,
      sha256: 'hash',
      url: '/api/telos/artifacts/artifact',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, artifact: receipt })));
    vi.stubGlobal('fetch', fetch);
    const input = {
      requestId: 'save-spec',
      itemId: 't',
      filename: 's.md',
      title: 'Spec',
      path: '/sandbox/spec.md',
    };
    const result = await executeTelosArtifactTool(
      'http://host',
      'client',
      'token',
      'TelosSaveArtifact',
      input,
    );
    expect(JSON.parse(result.content)).toEqual({ ok: true, artifact: receipt });
    expect(fetch).toHaveBeenCalledWith(
      'http://host/api/internal/telos/artifacts/save',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
        headers: expect.objectContaining({ 'X-Internal-Token': 'token', 'X-Client-Id': 'client' }),
      }),
    );
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'Workspace unavailable' }), { status: 409 }),
    );
    expect(
      await executeTelosArtifactTool('http://host', 'client', 'token', 'TelosSaveArtifact', input),
    ).toEqual({ content: 'Workspace unavailable', isError: true });
  });
});
