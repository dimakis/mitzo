import { describe, expect, it, vi } from 'vitest';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import {
  ContextMeasurementSchema,
  type ContextObservation,
} from '../../packages/protocol/src/context-measurement.js';
import { normalizeClaudeContext, normalizeCodexContext } from '../context-measurement-adapters.js';
import { inspectClaudeContext } from '../context-measurement-control.js';

const observation = {
  identity: {
    sessionId: 'chat',
    threadId: 'thread',
    queryId: 'query',
    turnId: 'turn',
    scope: 'parent' as const,
    ownerGeneration: 'generation-1',
  },
  binding: {
    engine: 'claude' as const,
    placement: 'local' as const,
    model: 'fixture-model',
    accountRef: 'fixture-account',
    runtimeBindingRevision: 'binding-1',
    runtimeVersion: 'fixture',
  },
  observedAt: 100,
};
const claude = () => ({
  model: 'fixture-model',
  totalTokens: 60,
  maxTokens: 90,
  rawMaxTokens: 100,
  percentage: 60,
  gridRows: [],
  categories: [
    { id: 'messages', name: 'Translated messages', kind: 'used', tokens: 40, color: 'red' },
    { id: 'memory_files', name: 'Memory', kind: 'used', tokens: 15, color: 'red' },
    { id: 'free_space', name: 'Free', kind: 'free', tokens: 30, color: 'green' },
    { id: 'autocompact_buffer', name: 'Reserve', kind: 'buffer', tokens: 10, color: 'gray' },
    { id: 'mcp_tools_deferred', name: 'Tools', kind: 'deferred', tokens: 500, color: 'blue' },
  ],
  memoryFiles: [{ path: '/fixture/AGENTS.md', type: 'Project', tokens: 15 }],
  mcpTools: [],
  agents: [],
});
const breakdown = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens: 20,
  reasoningOutputTokens: 2,
  totalTokens: inputTokens + outputTokens,
});
const codex = () => ({
  threadId: 'thread',
  turnId: 'turn',
  tokenUsage: { last: breakdown(50, 10), total: breakdown(150, 30), modelContextWindow: 100 },
});
const codexObservation = (): ContextObservation => ({
  ...observation,
  binding: { ...observation.binding, engine: 'codex' as const },
});

describe('versioned context measurement contract', () => {
  it('preserves an estimated total, reserve, deferred rows and signed residual without adding drilldowns twice', () => {
    const result = normalizeClaudeContext(claude(), observation, 'summary');
    expect(result.measurement).toEqual({
      basis: 'current-context-estimate',
      method: 'claude-summary',
      assurance: 'estimated',
    });
    expect(result.usedTokens).toBe(60);
    expect(result.capacity).toMatchObject({
      compactionWindowTokens: 100,
      usableWindowTokens: 90,
      bufferTokens: 10,
      freeTokens: 30,
      kind: 'unknown',
    });
    expect(result.reconciliation).toEqual({ residualTokens: 5, status: 'partial' });
    expect(result.contributions[0]).toMatchObject({
      relation: 'unknown',
      tokens: 15,
      categoryKey: 'memory_files',
    });
    expect(result.categories.find((row) => row.key === 'mcp_tools_deferred')?.kind).toBe(
      'deferred',
    );
    expect(result.contributions[0]).not.toHaveProperty('path');
    expect(JSON.stringify(result)).not.toContain('/fixture/');
  });

  it('retains unknown category IDs/kinds without classifying by English labels', () => {
    const raw = claude();
    raw.categories.push({
      id: 'future_category',
      name: 'Free space',
      tokens: 7,
      kind: 'future-kind',
      color: 'red',
    });
    const result = normalizeClaudeContext(
      { ...raw, secretFutureField: 'must not escape' },
      observation,
      'summary',
    );
    expect(result.categories.at(-1)).toMatchObject({ key: 'future_category', kind: 'unknown' });
    expect(result.reconciliation.status).toBe('unknown');
    expect(result).not.toHaveProperty('secretFutureField');
    expect(
      ContextMeasurementSchema.parse({ ...result, additiveFutureField: true }),
    ).not.toHaveProperty('additiveFutureField');
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'rejects invalid counts %s',
    (tokens) => {
      expect(() =>
        normalizeClaudeContext({ ...claude(), totalTokens: tokens }, observation, 'summary'),
      ).toThrow();
    },
  );

  it('retains overage and negative residual rather than clamping or inventing free space', () => {
    const raw = claude();
    raw.totalTokens = 120;
    raw.categories[0].tokens = 130;
    const result = normalizeClaudeContext(raw, observation, 'full');
    expect(result.usedTokens).toBe(120);
    expect(result.reconciliation).toEqual({ residualTokens: -25, status: 'inconsistent' });
    expect(result.capacity.freeTokens).toBe(30); // reported, not recomputed
    expect(result.measurement.assurance).toBe('mixed');
  });

  it('rejects wrong model, missing structure, duplicate categories and future major versions', () => {
    expect(() =>
      normalizeClaudeContext({ ...claude(), model: 'another' }, observation, 'summary'),
    ).toThrow();
    expect(() => normalizeClaudeContext({}, observation, 'summary')).toThrow();
    const raw = claude();
    raw.categories.push(raw.categories[0]);
    expect(() => normalizeClaudeContext(raw, observation, 'summary')).toThrow();
    const valid = normalizeClaudeContext(claude(), observation, 'summary');
    expect(ContextMeasurementSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(
      ContextMeasurementSchema.safeParse({
        ...valid,
        capacity: { ...valid.capacity, compactionWindowTokens: 0 },
      }).success,
    ).toBe(false);
    expect(
      ContextMeasurementSchema.safeParse({
        ...valid,
        contributions: [{ ...valid.contributions[0], categoryKey: 'absent' }],
      }).success,
    ).toBe(false);
  });

  it('allows zero observations but never converts missing measurements to zero', () => {
    const raw = { ...claude(), totalTokens: 0, categories: [], memoryFiles: [] };
    const result = normalizeClaudeContext(raw, observation, 'summary');
    expect(result.usedTokens).toBe(0);
    expect(result.capacity.freeTokens).toBeUndefined();
    expect(result.capacity.bufferTokens).toBeUndefined();
  });

  it.each(['local', 'openshell'] as const)(
    'keeps Codex %s request accounting separate from occupancy and counts cache/reasoning once',
    (placement) => {
      const context = codexObservation();
      context.binding.placement = placement;
      const result = normalizeCodexContext(codex(), context);
      expect(result.usedTokens).toBeUndefined();
      expect(result.requestUsage).toEqual({
        inputTokens: 50,
        cachedInputTokens: 20,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        totalTokens: 60,
      });
      expect(result.measurement.basis).toBe('latest-request');
      expect(result.categories).toEqual([]);
      expect(result.capacity.freeTokens).toBeUndefined();
    },
  );

  it('retains valid Codex accounting with unknown capacity, rejects wrong thread/turn and invalid subsets', () => {
    expect(
      normalizeCodexContext(
        { ...codex(), tokenUsage: { ...codex().tokenUsage, modelContextWindow: null } },
        codexObservation(),
      ).capacity.modelLimits,
    ).toBeUndefined();
    for (const patch of [{ threadId: 'other' }, { turnId: 'other' }]) {
      expect(() => normalizeCodexContext({ ...codex(), ...patch }, codexObservation())).toThrow();
    }
    const raw = codex();
    raw.tokenUsage.last.cachedInputTokens = 51;
    expect(() => normalizeCodexContext(raw, codexObservation())).toThrow();
  });

  it('rejects engine/basis confusion and parent/subagent scope ambiguity', () => {
    const result = normalizeCodexContext(codex(), codexObservation());
    expect(ContextMeasurementSchema.safeParse({ ...result, usedTokens: 60 }).success).toBe(false);
    expect(
      ContextMeasurementSchema.safeParse({ ...result, binding: observation.binding }).success,
    ).toBe(false);
    expect(
      ContextMeasurementSchema.safeParse({
        ...result,
        identity: { ...result.identity, scope: 'subagent' },
      }).success,
    ).toBe(false);
    expect(
      ContextMeasurementSchema.safeParse({
        ...result,
        identity: { ...result.identity, scope: 'subagent', parentSessionId: 'parent' },
      }).success,
    ).toBe(true);
  });
});

describe('bounded Claude context inspection', () => {
  it('contains malformed owner failures without reading unvalidated identity in diagnostics', async () => {
    const diagnostic = vi.fn();
    const result = await inspectClaudeContext({
      current: () => ({ active: true, identity: null }) as never,
      signal: new AbortController().signal,
      diagnostic,
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'control_failed' });
    expect(diagnostic).toHaveBeenCalledWith({
      reason: 'control_failed',
      sessionId: undefined,
      stage: 'context_inspection',
    });
  });
  function fixture() {
    const query = {
      marker: 'receiver',
      getContextUsage: vi.fn(async function (
        this: { marker: string },
        _options: { detail: 'summary' | 'full' },
      ) {
        expect(this.marker).toBe('receiver');
        return claude();
      }),
    };
    const owner = { ...observation, active: true, query };
    return { owner, query, current: () => owner };
  }
  it('explicitly requests summary from the existing owner without generation or implicit full calls', async () => {
    const f = fixture();
    const result = await inspectClaudeContext({
      current: f.current,
      signal: new AbortController().signal,
      now: () => 200,
    });
    expect(result.status).toBe('available');
    expect(f.query.getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: 'summary' });
    if (result.status === 'available') expect(result.snapshot.observedAt).toBe(200);
  });
  it('requires full token-count authority and rechecks it after the response', async () => {
    const f = fixture();
    const args = {
      current: f.current,
      signal: new AbortController().signal,
      detail: 'full' as const,
    };
    expect(await inspectClaudeContext(args)).toMatchObject({
      reason: 'token_count_not_authorized',
    });
    expect(f.query.getContextUsage).not.toHaveBeenCalled();
    const authorizeFull = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await inspectClaudeContext({ ...args, authorizeFull })).toMatchObject({
      reason: 'token_count_not_authorized',
    });
    expect(f.query.getContextUsage).toHaveBeenCalledExactlyOnceWith({ detail: 'full' });
  });
  it('accepts the installed SDK skills object without exposing source metadata or adding it twice', async () => {
    const f = fixture();
    const skills: NonNullable<SDKControlGetContextUsageResponse['skills']> = {
      totalSkills: 2,
      includedSkills: 1,
      tokens: 5,
      skillFrontmatter: [
        { name: 'private skill', source: 'project', path: '/private/skill', tokens: 5 },
      ],
    };
    const response = { ...claude(), skills };
    f.query.getContextUsage.mockResolvedValue(response);
    const result = await inspectClaudeContext({
      current: f.current,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.snapshot.usedTokens).toBe(60);
    expect(result.snapshot.contributions).toContainEqual({
      id: 'skills:0',
      sourceRef: 'sdk:skills:0',
      tokens: 5,
      relation: 'unknown',
      assurance: 'estimated',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each(['cancelled', 'scope_changed'] as const)(
    'does not dispatch after pre-dispatch %s',
    async (reason) => {
      const f = fixture();
      const controller = new AbortController();
      const pending = inspectClaudeContext({ current: f.current, signal: controller.signal });
      if (reason === 'cancelled') controller.abort();
      else f.owner.active = false;
      expect(await pending).toEqual({ status: 'unavailable', reason });
      expect(f.query.getContextUsage).not.toHaveBeenCalled();
    },
  );
  it.each([1, 2])(
    'rejects retirement after full authorization %s resolves',
    async (retireAfter) => {
      const f = fixture();
      let calls = 0;
      const result = await inspectClaudeContext({
        current: f.current,
        signal: new AbortController().signal,
        detail: 'full',
        authorizeFull: async () => {
          if (++calls === retireAfter) {
            // Run after authorize() checks ownership, before work() resumes its await.
            queueMicrotask(() =>
              queueMicrotask(() => {
                f.owner.active = false;
              }),
            );
          }
          return true;
        },
      });
      expect(result).toEqual({ status: 'unavailable', reason: 'scope_changed' });
      expect(f.query.getContextUsage).toHaveBeenCalledTimes(retireAfter - 1);
    },
  );
  it.each(['retired', 'binding', 'query'] as const)(
    'discards a late response after %s changes',
    async (change) => {
      const f = fixture();
      let resolve!: (value: ReturnType<typeof claude>) => void;
      f.query.getContextUsage.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = inspectClaudeContext({
        current: f.current,
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(f.query.getContextUsage).toHaveBeenCalledTimes(1));
      if (change === 'retired') f.owner.active = false;
      if (change === 'binding')
        f.owner.binding = { ...observation.binding, runtimeBindingRevision: 'next' };
      if (change === 'query') f.owner.query = { ...f.query };
      resolve(claude());
      expect(await pending).toMatchObject({ status: 'unavailable', reason: 'scope_changed' });
    },
  );
  it('reports method absence and unsupported ordinary OpenShell before calling a control', async () => {
    const f = fixture();
    expect(
      await inspectClaudeContext({
        current: () => ({ ...f.owner, query: {} }),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ reason: 'control_missing' });
    expect(
      await inspectClaudeContext({
        current: () => ({
          ...f.owner,
          binding: { ...observation.binding, placement: 'openshell' },
        }),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ reason: 'unsupported_route' });
    expect(f.query.getContextUsage).not.toHaveBeenCalled();
  });
  it('reports failures without leaking raw errors or falling back to full', async () => {
    const f = fixture();
    const diagnostic = vi.fn();
    f.query.getContextUsage.mockRejectedValue(new Error('private payload'));
    const result = await inspectClaudeContext({
      current: f.current,
      signal: new AbortController().signal,
      diagnostic,
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'control_failed' });
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'control_failed', sessionId: 'chat' }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private payload');
    expect(f.query.getContextUsage).toHaveBeenCalledTimes(1);
  });
  it('times out and aborts pending controls without claiming provider cancellation', async () => {
    const f = fixture();
    f.query.getContextUsage.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    expect(
      await inspectClaudeContext({ current: f.current, signal: controller.signal, timeoutMs: 5 }),
    ).toMatchObject({ reason: 'timed_out' });
    const pending = inspectClaudeContext({ current: f.current, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ reason: 'cancelled' });
  });
});
