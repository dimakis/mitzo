import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleVertexModelProvider } from '../src/providers/google-vertex.js';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

// These are offline failure-path tests: neither gcloud nor a provider is invoked.
describe('Google Vertex authentication errors', () => {
  let failure: NodeJS.ErrnoException;
  const fetch = vi.fn();

  beforeEach(() => {
    failure = Object.assign(new Error('synthetic process failure'), { code: 'ENOENT' });
    execFile.mockImplementation((_binary, _args, _options, callback) => callback(failure));
    vi.stubGlobal('fetch', fetch);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the missing-command cause alongside actionable installation guidance', async () => {
    const provider = new GoogleVertexModelProvider('fixture-model', { projectId: 'fixture' });

    await expect(provider.call([])).rejects.toMatchObject({
      message:
        'gcloud CLI not found — install Google Cloud SDK or configure Application Default Credentials',
      cause: failure,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves other authentication errors without reaching the provider', async () => {
    failure.code = 'EACCES';
    const provider = new GoogleVertexModelProvider('fixture-model', { projectId: 'fixture' });

    await expect(provider.call([])).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });
});
