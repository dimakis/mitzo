import { describe, expect, it } from 'vitest';
import { verifyObservability } from '../observability-readback.mjs';

const now = Date.parse('2026-11-20T12:00:00Z');
const fixtures: Record<string, unknown> = {
  '/ready': 'ready',
  '/loki/api/v1/query_range': {
    status: 'success',
    data: { result: [{ values: [[String(BigInt(now) * 1000000n), '{"msg":"private payload"}']] }] },
  },
  '/api/v3/traces': {
    result: {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: 'a'.repeat(32), startTimeUnixNano: String(BigInt(now) * 1000000n) },
              ],
            },
          ],
        },
      ],
    },
  },
  '/api/health': { database: 'ok' },
  '/api/datasources': [
    { uid: 'loki', type: 'loki' },
    { uid: 'jaeger', type: 'jaeger' },
  ],
  '/api/datasources/uid/loki/health': { status: 'OK' },
  '/api/datasources/uid/jaeger/health': { status: 'OK' },
  '/api/2.0/mlflow/experiments/search': { experiments: [{ experiment_id: '0' }] },
  '/api/2.0/mlflow/runs/search': { runs: [] },
};
function fakeFetch(overrides: Record<string, unknown> = {}) {
  return async (url: string | URL) => {
    const path = new URL(url).pathname;
    const backendPath = path.replace(/^\/api\/datasources\/proxy\/uid\/[^/]+/, '');
    const value = path in overrides ? overrides[path] : fixtures[backendPath];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`Unexpected request ${path}`);
    return new Response(typeof value === 'string' ? value : JSON.stringify(value));
  };
}

describe('observability readback', () => {
  it('checks data access and reports activity without returning private logs', async () => {
    const result = await verifyObservability({ fetchImpl: fakeFetch(), now });
    expect(result.ok).toBe(true);
    expect(result.services.loki).toMatchObject({ ok: true, recentRecords: 1 });
    expect(result.services.jaeger).toMatchObject({ ok: true, recentRecords: 1 });
    expect(result.services.mlflow).toMatchObject({ ok: true, experiments: 1, runs: 0 });
    expect(JSON.stringify(result)).not.toContain('private payload');
  });
  it.each([
    ['/loki/api/v1/query_range', { status: 'error', error: 'private failure' }, 'loki'],
    ['/api/v3/traces', { unexpected: [] }, 'jaeger'],
    ['/api/datasources/uid/jaeger/health', { status: 'ERROR' }, 'grafana'],
    ['/api/datasources/proxy/uid/loki/loki/api/v1/query_range', { status: 'error' }, 'grafana'],
    ['/api/2.0/mlflow/experiments/search', new Error('private failure'), 'mlflow'],
  ])('fails for unusable readback at %s even when health is green', async (path, body, service) => {
    const result = await verifyObservability({ fetchImpl: fakeFetch({ [path]: body }), now });
    expect(result.ok).toBe(false);
    expect(result.services[service].ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private failure');
  });
  it.each([
    [
      '/api/datasources/proxy/uid/loki/loki/api/v1/query_range',
      { status: 'success', data: { result: [] } },
    ],
    ['/api/datasources/proxy/uid/jaeger/api/v3/traces', { result: {} }],
  ])('requires fresh data through Grafana too: %s', async (path, body) => {
    const result = await verifyObservability({
      fetchImpl: fakeFetch({ [path]: body }),
      now,
      requireRecent: true,
    });
    expect(result.ok).toBe(false);
    expect(result.services.grafana).toMatchObject({
      ok: false,
      code: 'NO_RECENT_DATA',
      stage: path,
    });
  });
  it('preserves the traces-only startup path without querying unrelated services', async () => {
    const result = await verifyObservability({ fetchImpl: fakeFetch(), now, tracesOnly: true });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.services)).toEqual(['jaeger']);
  });
  it('distinguishes a quiet pipeline from verified fresh activity', async () => {
    const result = await verifyObservability({
      fetchImpl: fakeFetch({
        '/loki/api/v1/query_range': { status: 'success', data: { result: [] } },
      }),
      now,
      requireRecent: true,
    });
    expect(result.ok).toBe(false);
    expect(result.services.loki).toMatchObject({
      ok: false,
      recentRecords: 0,
      code: 'NO_RECENT_DATA',
    });
  });
});
