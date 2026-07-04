/**
 * MLflow session tracking — lightweight REST client.
 *
 * Each Mitzo session becomes an MLflow run in the "mitzo-sessions" experiment.
 * All functions are no-ops when MLFLOW_TRACKING_URI is not set, so callers
 * never need to guard.
 *
 * Endpoints used:
 *   POST /api/2.0/mlflow/experiments/search
 *   POST /api/2.0/mlflow/experiments/create
 *   POST /api/2.0/mlflow/runs/create
 *   POST /api/2.0/mlflow/runs/log-batch
 *   POST /api/2.0/mlflow/runs/update
 */

import { createLogger } from './logger.js';

const log = createLogger('mlflow');

const TRACKING_URI = process.env.MLFLOW_TRACKING_URI ?? '';
const EXPERIMENT_NAME = 'mitzo-sessions';

let cachedExperimentId: string | null = null;

export function isEnabled(): boolean {
  return TRACKING_URI.length > 0;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${TRACKING_URI}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MLflow ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Experiment management
// ---------------------------------------------------------------------------

async function ensureExperiment(): Promise<string> {
  if (cachedExperimentId) return cachedExperimentId;

  // Search for existing experiment
  interface SearchResult {
    experiments?: Array<{ experiment_id: string; name: string }>;
  }
  const search = await post<SearchResult>('/api/2.0/mlflow/experiments/search', {
    max_results: 1,
    filter: `name = '${EXPERIMENT_NAME}'`,
  });
  if (search.experiments?.length) {
    cachedExperimentId = search.experiments[0].experiment_id;
    return cachedExperimentId;
  }

  // Create new experiment
  interface CreateResult {
    experiment_id: string;
  }
  const created = await post<CreateResult>('/api/2.0/mlflow/experiments/create', {
    name: EXPERIMENT_NAME,
  });
  cachedExperimentId = created.experiment_id;
  log.info('created MLflow experiment', { name: EXPERIMENT_NAME, id: cachedExperimentId });
  return cachedExperimentId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SessionParams {
  sessionId: string;
  mode?: string;
  model?: string;
  cwd?: string;
  branch?: string;
  clientType?: string;
  agentDefHash?: string;
  recipeHash?: string;
}

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
  durationMs: number;
  durationApiMs: number;
  numCompactions?: number;
}

/**
 * Create an MLflow run for a session. Returns the run_id, or null if disabled.
 */
export async function createRun(params: SessionParams): Promise<string | null> {
  if (!isEnabled()) return null;

  try {
    const experimentId = await ensureExperiment();

    interface RunResult {
      run: { info: { run_id: string } };
    }

    const tags = [
      { key: 'session.id', value: params.sessionId },
      ...(params.mode ? [{ key: 'session.mode', value: params.mode }] : []),
      ...(params.model ? [{ key: 'session.model', value: params.model }] : []),
      ...(params.clientType ? [{ key: 'session.client_type', value: params.clientType }] : []),
      ...(params.agentDefHash
        ? [{ key: 'context.agent_def_hash', value: params.agentDefHash }]
        : []),
      ...(params.recipeHash ? [{ key: 'context.recipe_hash', value: params.recipeHash }] : []),
    ];

    const result = await post<RunResult>('/api/2.0/mlflow/runs/create', {
      experiment_id: experimentId,
      run_name: params.sessionId,
      start_time: Date.now(),
      tags,
    });

    const runId = result.run.info.run_id;

    // Log params (immutable session metadata)
    const runParams = [
      { key: 'cwd', value: params.cwd ?? '' },
      { key: 'mode', value: params.mode ?? '' },
      { key: 'model', value: params.model ?? '' },
      { key: 'branch', value: params.branch ?? '' },
    ];

    await post('/api/2.0/mlflow/runs/log-batch', {
      run_id: runId,
      params: runParams,
    });

    log.info('created MLflow run', { runId, sessionId: params.sessionId });
    return runId;
  } catch (err) {
    log.warn('failed to create MLflow run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * End an MLflow run, logging final session metrics.
 */
export async function endRun(
  runId: string | null,
  metrics: SessionMetrics,
  status: 'FINISHED' | 'FAILED' = 'FINISHED',
): Promise<void> {
  if (!isEnabled() || !runId) return;

  try {
    const now = Date.now();

    // Log all metrics in a single batch
    const mlMetrics = [
      { key: 'tokens.input', value: metrics.inputTokens, timestamp: now, step: 0 },
      { key: 'tokens.output', value: metrics.outputTokens, timestamp: now, step: 0 },
      { key: 'tokens.cache_read', value: metrics.cacheReadTokens, timestamp: now, step: 0 },
      {
        key: 'tokens.cache_creation',
        value: metrics.cacheCreationTokens,
        timestamp: now,
        step: 0,
      },
      { key: 'cost_usd', value: metrics.totalCostUsd, timestamp: now, step: 0 },
      { key: 'num_turns', value: metrics.numTurns, timestamp: now, step: 0 },
      { key: 'duration_ms', value: metrics.durationMs, timestamp: now, step: 0 },
      { key: 'duration_api_ms', value: metrics.durationApiMs, timestamp: now, step: 0 },
    ];

    if (metrics.numCompactions !== undefined) {
      mlMetrics.push({
        key: 'num_compactions',
        value: metrics.numCompactions,
        timestamp: now,
        step: 0,
      });
    }

    await post('/api/2.0/mlflow/runs/log-batch', {
      run_id: runId,
      metrics: mlMetrics,
    });

    await post('/api/2.0/mlflow/runs/update', {
      run_id: runId,
      status,
      end_time: now,
    });

    log.info('ended MLflow run', { runId, status });
  } catch (err) {
    log.warn('failed to end MLflow run', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// For testing — reset cached experiment ID
export function _resetCache(): void {
  cachedExperimentId = null;
}
