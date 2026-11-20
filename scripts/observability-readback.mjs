import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';

const DEFAULT_ENDPOINTS = {
  loki: 'http://127.0.0.1:3200',
  jaeger: 'http://127.0.0.1:16686',
  grafana: 'http://127.0.0.1:3002',
  mlflow: 'http://127.0.0.1:5050',
};
function demand(condition, code = 'INVALID_READBACK') {
  if (!condition) throw new Error(code);
}
function spans(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(spans);
  if ('traceId' in value && 'startTimeUnixNano' in value) return [value];
  return Object.values(value).flatMap(spans);
}
/** Read-only checks. Never echo log messages, trace attributes, experiment names or server errors. */
export async function verifyObservability({
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  requireRecent = false,
  tracesOnly = false,
  endpoints = DEFAULT_ENDPOINTS,
} = {}) {
  const services = {};
  const stages = {};
  const since = now - 5 * 60_000;
  const signal = globalThis.AbortSignal.timeout(8000);
  const lokiQuery = new globalThis.URLSearchParams({
    query: '{app="mitzo"}',
    start: `${BigInt(since) * 1000000n}`,
    end: `${BigInt(now) * 1000000n}`,
    limit: '20',
    direction: 'backward',
  });
  const jaegerQuery = new globalThis.URLSearchParams({
    'query.service_name': 'mitzo',
    'query.start_time_min': new Date(since).toISOString(),
    'query.start_time_max': new Date(now).toISOString(),
    'query.num_traces': '5',
  });
  const paths = {
    loki: `/loki/api/v1/query_range?${lokiQuery}`,
    jaeger: `/api/v3/traces?${jaegerQuery}`,
  };
  function validReadback(type, data) {
    demand(
      type === 'loki'
        ? data.status === 'success' && Array.isArray(data.data?.result)
        : data && typeof data === 'object' && 'result' in data,
    );
  }
  async function request(service, path, payload) {
    stages[service] = path.split('?')[0].slice(0, 160);
    const response = await fetchImpl(new URL(path, endpoints[service]), {
      signal,
      ...(payload
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }
        : {}),
    });
    demand(response.ok, `HTTP_${response.status}`);
    return response;
  }
  const json = async (service, path, payload) => (await request(service, path, payload)).json();
  async function check(service, operation) {
    if (tracesOnly && service !== 'jaeger') return;
    const started = performance.now();
    try {
      services[service] = { ok: true, ...(await operation()) };
    } catch (error) {
      const code =
        error instanceof Error &&
        /^(HTTP_\d{3}|INVALID_READBACK|NO_RECENT_DATA|DATASOURCE_UNAVAILABLE)$/.test(error.message)
          ? error.message
          : 'READBACK_UNAVAILABLE';
      const cause = error?.cause ?? error;
      const causeCode =
        typeof cause?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(cause.code)
          ? cause.code
          : undefined;
      const causeName =
        typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name)
          ? error.name
          : 'Error';
      services[service] = {
        ...services[service],
        ok: false,
        code,
        stage: stages[service] ?? 'readback-validation',
        causeName,
        ...(causeCode ? { causeCode } : {}),
      };
    }
    services[service].durationMs = Math.round(performance.now() - started);
  }
  function timestamps(type, data) {
    return type === 'loki'
      ? data.data.result.flatMap((stream) =>
          stream.values.map(([time]) => Number(BigInt(time) / 1000000n)),
        )
      : spans(data).map((span) => Number(BigInt(span.startTimeUnixNano) / 1000000n));
  }
  function activity(service, timestamps) {
    const recentRecords = timestamps.filter((time) => time >= since && time <= now + 60_000).length;
    const result = {
      recentRecords,
      newestAgeSeconds: timestamps.length
        ? Math.round((now - Math.max(...timestamps)) / 1000)
        : null,
    };
    services[service] = result;
    demand(!requireRecent || recentRecords > 0, 'NO_RECENT_DATA');
    return result;
  }
  await Promise.all([
    check('loki', async () => {
      await request('loki', '/ready');
      const data = await json('loki', paths.loki);
      validReadback('loki', data);
      return activity('loki', timestamps('loki', data));
    }),
    check('jaeger', async () => {
      const data = await json('jaeger', paths.jaeger);
      validReadback('jaeger', data);
      return activity('jaeger', timestamps('jaeger', data));
    }),
    check('grafana', async () => {
      const health = await json('grafana', '/api/health');
      demand(health.database === 'ok');
      const sources = await json('grafana', '/api/datasources');
      demand(Array.isArray(sources));
      const proxyRecentRecords = {};
      for (const type of ['loki', 'jaeger']) {
        const source = sources.find((item) => item.type === type);
        demand(source?.uid, 'DATASOURCE_UNAVAILABLE');
        const result = await json(
          'grafana',
          `/api/datasources/uid/${encodeURIComponent(source.uid)}/health`,
        );
        demand(result.status === 'OK', 'DATASOURCE_UNAVAILABLE');
        const data = await json(
          'grafana',
          `/api/datasources/proxy/uid/${encodeURIComponent(source.uid)}${paths[type]}`,
        );
        validReadback(type, data);
        proxyRecentRecords[type] = activity('grafana', timestamps(type, data)).recentRecords;
      }
      return { datasources: 2, proxyRecentRecords };
    }),
    check('mlflow', async () => {
      const data = await json('mlflow', '/api/2.0/mlflow/experiments/search', {
        max_results: 20,
        view_type: 'ACTIVE_ONLY',
      });
      demand(Array.isArray(data.experiments));
      const ids = data.experiments.map((item) => item.experiment_id);
      const result = ids.length
        ? await json('mlflow', '/api/2.0/mlflow/runs/search', {
            experiment_ids: ids,
            max_results: 5,
            order_by: ['attributes.start_time DESC'],
          })
        : {};
      demand(!result.runs || Array.isArray(result.runs));
      const runs = result.runs ?? [];
      const diagnosticRuns = runs.filter((run) =>
        run.data?.tags?.some(
          (tag) => tag.key === 'mitzo.purpose' && tag.value.startsWith('infrastructure-diagnostic'),
        ),
      ).length;
      return {
        experiments: ids.length,
        runs: runs.length,
        diagnosticRuns,
        applicationRuns: runs.length - diagnosticRuns,
        role: 'experiments-and-learning-metrics',
      };
    }),
  ]);
  return {
    ok: Object.values(services).every((service) => service.ok),
    checkedAt: new Date(now).toISOString(),
    services,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyObservability({
    requireRecent: process.argv.includes('--require-recent'),
    tracesOnly: process.argv.includes('--traces-only'),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
