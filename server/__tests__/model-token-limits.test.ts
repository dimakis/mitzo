import { describe, expect, it, vi } from 'vitest';
import {
  ModelTokenLimitCatalog,
  providerTokenLimits,
  runtimeTokenLimits,
  tokenLimitCeiling,
} from '../model-token-limits.js';

const feed = (context = 128000) => ({
  openai: { models: { 'new-model': { id: 'new-model', limit: { context, output: 16000 } } } },
  'google-vertex': {
    models: {
      'new-model': { id: 'new-model', limit: { context: 1000000, input: 900000, output: 32000 } },
    },
  },
});

describe('dynamic model token limits', () => {
  it('reads an exact provider/model entry without a model list in code', async () => {
    const load = vi.fn().mockResolvedValue(feed());
    const catalog = new ModelTokenLimitCatalog(load, () => 100);
    expect(await catalog.resolve('openai', 'new-model')).toMatchObject({
      model: 'new-model',
      source: 'catalog',
      contextWindow: 128000,
      outputTokenLimit: 16000,
      checkedAt: 100,
      stale: false,
    });
    expect(await catalog.resolve('google-vertex', 'new-model')).toMatchObject({
      contextWindow: 1000000,
      inputTokenLimit: 900000,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('does not guess aliases, unknown routes, or native Codex effective limits', async () => {
    const catalog = new ModelTokenLimitCatalog(async () => feed());
    for (const [provider, model] of [
      ['openai', 'new-model-latest'],
      ['other', 'new-model'],
      ['openai-codex', 'new-model'],
    ]) {
      expect(await catalog.resolve(provider, model)).toMatchObject({ source: 'unknown', model });
    }
  });
  it('refreshes after expiry and discovers newly added models automatically', async () => {
    let now = 100;
    const load = vi.fn().mockResolvedValue(feed());
    const catalog = new ModelTokenLimitCatalog(load, () => now, 1000);
    await catalog.resolve('openai', 'new-model');
    now += 1001;
    load.mockResolvedValue({
      openai: { models: { fresh: { id: 'fresh', limit: { context: 256000 } } } },
    });
    expect(await catalog.resolve('openai', 'fresh')).toMatchObject({ contextWindow: 256000 });
    expect(await catalog.resolve('openai', 'new-model')).toMatchObject({ source: 'unknown' });
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('deduplicates simultaneous refreshes and marks expired cached evidence stale on failure', async () => {
    let now = 100;
    const load = vi.fn().mockResolvedValue(feed());
    const catalog = new ModelTokenLimitCatalog(load, () => now, 1000);
    await Promise.all([
      catalog.resolve('openai', 'new-model'),
      catalog.resolve('google-vertex', 'new-model'),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    now += 1001;
    load.mockRejectedValue(new Error('offline'));
    const stale = await catalog.resolve('openai', 'new-model');
    expect(stale).toMatchObject({ contextWindow: 128000, checkedAt: 100, stale: true });
    expect(tokenLimitCeiling(stale)).toBe(0);
    await catalog.resolve('openai', 'new-model');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each([0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid context limits %s',
    async (context) => {
      const catalog = new ModelTokenLimitCatalog(async () => feed(context));
      expect(tokenLimitCeiling(await catalog.resolve('openai', 'new-model'))).toBe(0);
    },
  );
  it('rejects model key/ID mismatches and does not accept inherited entries', async () => {
    const data = feed();
    data.openai.models['new-model'].id = 'other';
    const catalog = new ModelTokenLimitCatalog(async () => data);
    expect(await catalog.resolve('openai', 'new-model')).toMatchObject({ source: 'unknown' });
    expect(await catalog.resolve('openai', 'toString')).toMatchObject({ source: 'unknown' });
  });
  it('prefers matching runtime evidence, then provider metadata, before public catalog data', async () => {
    const load = vi.fn().mockResolvedValue(feed());
    const catalog = new ModelTokenLimitCatalog(load);
    expect(
      await catalog.resolve('openai', 'new-model', {
        runtime: runtimeTokenLimits('new-model', 64000),
      }),
    ).toMatchObject({ source: 'runtime', contextWindow: 64000 });
    expect(load).not.toHaveBeenCalled();
    expect(
      await catalog.resolve('google-vertex', 'new-model', {
        providerMetadata: { inputTokenLimit: 900000, outputTokenLimit: 32000 },
      }),
    ).toMatchObject({ source: 'provider', inputTokenLimit: 900000 });
    expect(load).not.toHaveBeenCalled();
    expect(
      await catalog.resolve('openai', 'new-model', {
        runtime: runtimeTokenLimits('other-model', 16000),
      }),
    ).toMatchObject({ source: 'catalog', contextWindow: 128000 });
  });
  it('keeps provider input and output limits separate', () => {
    const limits = providerTokenLimits(
      'google-vertex',
      'gemini-new',
      { inputTokenLimit: 1000000, outputTokenLimit: 64000 },
      100,
    );
    expect(limits).toMatchObject({
      inputTokenLimit: 1000000,
      outputTokenLimit: 64000,
      source: 'provider',
    });
    expect(limits).not.toHaveProperty('contextWindow');
    expect(tokenLimitCeiling(limits)).toBe(1000000);
  });
  it('validates runtime evidence and keeps it separate from catalog maxima', () => {
    const limits = runtimeTokenLimits('new-model', 64000, 8000, 100);
    expect(limits).toMatchObject({
      contextWindow: 64000,
      outputTokenLimit: 8000,
      source: 'runtime',
    });
    expect(tokenLimitCeiling(limits)).toBe(64000);
    expect(runtimeTokenLimits('new-model', NaN)).toBeUndefined();
  });
});
