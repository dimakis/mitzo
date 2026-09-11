import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must set env before importing
vi.stubEnv('MLFLOW_TRACKING_URI', 'http://localhost:5050');

describe('mlflow session tracking', () => {
  let mlflow: typeof import('../mlflow.js');

  beforeEach(async () => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubEnv('MLFLOW_TRACKING_URI', 'http://localhost:5050');
    mlflow = await import('../mlflow.js');
    mlflow._resetCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('isEnabled returns true when MLFLOW_TRACKING_URI is set', () => {
    expect(mlflow.isEnabled()).toBe(true);
  });

  describe('createRun', () => {
    it('creates experiment and run on first call', async () => {
      // First call: search returns empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ experiments: [] }),
      });
      // Second call: create experiment
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ experiment_id: '1' }),
      });
      // Third call: create run
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            run: { info: { run_id: 'run-abc' } },
          }),
      });
      // Fourth call: log-batch params
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const runId = await mlflow.createRun({
        sessionId: 'sess-123',
        mode: 'conversational',
        model: 'opus',
        cwd: '/repo',
        branch: 'main',
      });

      expect(runId).toBe('run-abc');
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Verify experiment search
      const searchCall = mockFetch.mock.calls[0];
      expect(searchCall[0]).toBe('http://localhost:5050/api/2.0/mlflow/experiments/search');

      // Verify experiment create
      const createExpCall = mockFetch.mock.calls[1];
      expect(createExpCall[0]).toBe('http://localhost:5050/api/2.0/mlflow/experiments/create');

      // Verify run create
      const createRunCall = mockFetch.mock.calls[2];
      expect(createRunCall[0]).toBe('http://localhost:5050/api/2.0/mlflow/runs/create');
      const runBody = JSON.parse(createRunCall[1].body);
      expect(runBody.experiment_id).toBe('1');
      expect(runBody.run_name).toBe('sess-123');
      expect(runBody.tags).toEqual(
        expect.arrayContaining([
          { key: 'session.id', value: 'sess-123' },
          { key: 'session.mode', value: 'conversational' },
          { key: 'session.model', value: 'opus' },
        ]),
      );

      // Verify params logged
      const paramsCall = mockFetch.mock.calls[3];
      const paramsBody = JSON.parse(paramsCall[1].body);
      expect(paramsBody.run_id).toBe('run-abc');
      expect(paramsBody.params).toEqual(
        expect.arrayContaining([
          { key: 'cwd', value: '/repo' },
          { key: 'branch', value: 'main' },
        ]),
      );
    });

    it('reuses cached experiment ID on subsequent calls', async () => {
      // First call: search finds existing experiment
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            experiments: [{ experiment_id: '42', name: 'mitzo-sessions' }],
          }),
      });
      // Create run
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            run: { info: { run_id: 'run-1' } },
          }),
      });
      // Log params
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await mlflow.createRun({ sessionId: 'sess-1' });

      // Second call should skip experiment search (cached)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            run: { info: { run_id: 'run-2' } },
          }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const runId = await mlflow.createRun({ sessionId: 'sess-2' });
      expect(runId).toBe('run-2');
      // 3 calls for first run + 2 for second (no experiment search)
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it('returns null on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const runId = await mlflow.createRun({ sessionId: 'sess-fail' });
      expect(runId).toBeNull();
    });
  });

  describe('endRun', () => {
    it('logs metrics and updates run status', async () => {
      // log-batch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // update
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await mlflow.endRun(
        'run-abc',
        {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheCreationTokens: 100,
          totalCostUsd: 0.05,
          numTurns: 3,
          durationMs: 30000,
          durationApiMs: 25000,
          numCompactions: 1,
        },
        'FINISHED',
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify metrics batch
      const batchCall = mockFetch.mock.calls[0];
      expect(batchCall[0]).toBe('http://localhost:5050/api/2.0/mlflow/runs/log-batch');
      const batchBody = JSON.parse(batchCall[1].body);
      expect(batchBody.run_id).toBe('run-abc');
      expect(batchBody.metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'tokens.input', value: 1000 }),
          expect.objectContaining({ key: 'tokens.output', value: 500 }),
          expect.objectContaining({ key: 'cost_usd', value: 0.05 }),
          expect.objectContaining({ key: 'num_turns', value: 3 }),
          expect.objectContaining({ key: 'num_compactions', value: 1 }),
        ]),
      );

      // Verify run update
      const updateCall = mockFetch.mock.calls[1];
      expect(updateCall[0]).toBe('http://localhost:5050/api/2.0/mlflow/runs/update');
      const updateBody = JSON.parse(updateCall[1].body);
      expect(updateBody.run_id).toBe('run-abc');
      expect(updateBody.status).toBe('FINISHED');
      expect(updateBody.end_time).toBeGreaterThan(0);
    });

    it('skips compaction metric when undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await mlflow.endRun('run-abc', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
        durationMs: 0,
        durationApiMs: 0,
      });

      const batchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const keys = batchBody.metrics.map((m: { key: string }) => m.key);
      expect(keys).not.toContain('num_compactions');
    });

    it('is a no-op when runId is null', async () => {
      await mlflow.endRun(null, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        numTurns: 0,
        durationMs: 0,
        durationApiMs: 0,
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sets FAILED status on error sessions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await mlflow.endRun(
        'run-err',
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          numTurns: 0,
          durationMs: 0,
          durationApiMs: 0,
        },
        'FAILED',
      );

      const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(updateBody.status).toBe('FAILED');
    });
  });
});

describe('mlflow disabled', () => {
  it('is a no-op when MLFLOW_TRACKING_URI is not set', async () => {
    vi.resetModules();
    mockFetch.mockReset();
    vi.stubEnv('MLFLOW_TRACKING_URI', '');

    const mlflow = await import('../mlflow.js');
    expect(mlflow.isEnabled()).toBe(false);

    const runId = await mlflow.createRun({ sessionId: 'test' });
    expect(runId).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();

    await mlflow.endRun('run-id', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
