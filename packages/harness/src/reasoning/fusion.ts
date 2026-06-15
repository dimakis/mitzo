/**
 * Fusion orchestrator — parallel fan-out + judge synthesis.
 *
 * Inspired by OpenRouter's Fusion API. Dispatches the same task to N models
 * in parallel, then a judge model performs structured comparison analysis,
 * and a synthesizer writes the final answer grounded in that analysis.
 *
 * Key insight from OpenRouter benchmarks: ~75% of fusion's performance lift
 * comes from the structured synthesis step, not from model diversity. Even
 * self-fusion (same model twice) gains +6.7pp.
 *
 * Three-stage pipeline:
 * 1. Fan-out — parallel dispatch to panel models
 * 2. Judge — structured analysis (consensus, contradictions, unique insights, blind spots)
 * 3. Synthesize — final answer grounded in judge analysis
 */

import { createLogger } from '../logger.js';
import { createProvider } from '../providers/index.js';
import type { ModelProvider } from '../providers/types.js';
import type { FusionConfig, FusionResult, JudgeAnalysis, TranscriptEntry } from './types.js';

const log = createLogger('fusion');

export class FusionOrchestrator {
  private panelProviders: Array<{ model: string; provider: ModelProvider }>;
  private judgeProvider: ModelProvider;
  private synthesizerProvider: ModelProvider;
  private config: FusionConfig;
  private transcript: TranscriptEntry[] = [];
  private totalCost = 0;

  constructor(config: FusionConfig) {
    this.config = config;

    // Create one provider per panel member
    this.panelProviders = config.panelModels.map((pm) => ({
      model: pm.model,
      provider: createProvider(pm.model),
    }));

    this.judgeProvider = createProvider(config.judgeModel.model);

    // Synthesizer defaults to judge if not specified
    this.synthesizerProvider = config.synthesizerModel
      ? createProvider(config.synthesizerModel.model)
      : this.judgeProvider;
  }

  async run(task: string, context: string): Promise<FusionResult> {
    // Reset instance state for safe reuse
    this.transcript = [];
    this.totalCost = 0;

    const { onEvent } = this.config;

    log.info('Starting fusion', {
      panelSize: this.panelProviders.length,
      panelModels: this.panelProviders.map((p) => p.model),
      judgeModel: this.config.judgeModel.model,
    });

    onEvent?.({ type: 'reasoning_start', mode: 'fusion', task });

    // Phase 1: Fan-out (parallel)
    const panelResponses = await this.fanOut(task, context);

    if (this.budgetExhausted()) {
      log.warn('Budget exhausted after fan-out, returning best panel response');
      onEvent?.({ type: 'reasoning_end', mode: 'fusion', totalCost: this.totalCost });
      // Return the longest panel response as a reasonable fallback
      const best = panelResponses.reduce((a, b) => (a.response.length > b.response.length ? a : b));
      return {
        finalOutput: best.response,
        judgeAnalysis: {
          consensus: [],
          contradictions: [],
          partialCoverage: [],
          uniqueInsights: [],
          blindSpots: [],
        },
        panelResponses,
        totalCost: this.totalCost,
        transcript: this.transcript,
      };
    }

    // Phase 2: Judge analysis
    const judgeAnalysis = await this.judge(panelResponses, task, context);

    if (this.budgetExhausted()) {
      log.warn('Budget exhausted after judge, synthesizing from analysis only');
    }

    // Phase 3: Synthesize final answer
    const finalOutput = await this.synthesize(judgeAnalysis, panelResponses, task, context);

    onEvent?.({ type: 'reasoning_end', mode: 'fusion', totalCost: this.totalCost });

    log.info('Fusion complete', {
      panelSize: panelResponses.length,
      consensusPoints: judgeAnalysis.consensus.length,
      contradictions: judgeAnalysis.contradictions.length,
      totalCost: `$${this.totalCost.toFixed(4)}`,
    });

    return {
      finalOutput,
      judgeAnalysis,
      panelResponses,
      totalCost: this.totalCost,
      transcript: this.transcript,
    };
  }

  // ─── Phase implementations ───────────────────────────────────────────────

  private async fanOut(
    task: string,
    context: string,
  ): Promise<Array<{ model: string; response: string }>> {
    const { onEvent } = this.config;

    const prompt = `## Context\n${context}\n\n## Task\n${task}\n\nProvide a thorough, well-reasoned response.`;

    // Launch all panel calls in parallel
    const results = await Promise.allSettled(
      this.panelProviders.map(async ({ model, provider }, index) => {
        const speaker = `panel-${index + 1}`;
        const systemPrompt =
          this.config.panelModels[index].systemPrompt ??
          'You are a knowledgeable assistant. Provide a thorough, well-reasoned response to the task.';

        onEvent?.({ type: 'phase_start', phase: 'fan-out', speaker, model });

        const response = await provider.call(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          { temperature: 0.7 },
        );

        this.totalCost += response.costUsd;

        this.transcript.push({
          speaker,
          model: response.model,
          phase: 'fan-out',
          content: response.content,
          usage: response.usage,
          costUsd: response.costUsd,
          timestamp: Date.now(),
        });

        onEvent?.({
          type: 'phase_end',
          phase: 'fan-out',
          speaker,
          content: response.content,
          costUsd: response.costUsd,
        });

        return { model, response: response.content };
      }),
    );

    // Collect successful results, log failures
    const panelResponses: Array<{ model: string; response: string }> = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        panelResponses.push(result.value);
      } else {
        log.error('Panel member failed', { error: result.reason });
      }
    }

    if (panelResponses.length === 0) {
      throw new Error('All panel members failed — no responses to judge');
    }

    return panelResponses;
  }

  private async judge(
    panelResponses: Array<{ model: string; response: string }>,
    task: string,
    context: string,
  ): Promise<JudgeAnalysis> {
    const { onEvent } = this.config;

    const responsesBlock = panelResponses
      .map((r, i) => `### Panel Member ${i + 1} (${r.model})\n${r.response}`)
      .join('\n\n---\n\n');

    const judgeSystemPrompt = this.config.judgeModel.systemPrompt ?? JUDGE_SYSTEM_PROMPT;

    const prompt = `## Original Task\n${task}\n\n## Context\n${context}\n\n## Panel Responses\n\n${responsesBlock}\n\n## Your Task\nAnalyze all panel responses and produce a structured comparison. Output a JSON object with this exact structure:\n\n{\n  "consensus": ["point 1", "point 2"],\n  "contradictions": [\n    {\n      "topic": "what they disagree about",\n      "positions": [\n        { "model": "model-name", "position": "their stance" }\n      ]\n    }\n  ],\n  "partial_coverage": ["topic only some addressed"],\n  "unique_insights": [\n    { "model": "model-name", "insight": "what they uniquely contributed" }\n  ],\n  "blind_spots": ["question none addressed"]\n}\n\nBe thorough and specific. Every entry should reference concrete content from the panel responses.`;

    onEvent?.({
      type: 'phase_start',
      phase: 'judge',
      speaker: 'judge',
      model: this.config.judgeModel.model,
    });

    const response = await this.judgeProvider.call(
      [
        { role: 'system', content: judgeSystemPrompt },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.3, responseFormat: 'json' },
    );

    this.totalCost += response.costUsd;

    this.transcript.push({
      speaker: 'judge',
      model: response.model,
      phase: 'judge',
      content: response.content,
      usage: response.usage,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    onEvent?.({
      type: 'phase_end',
      phase: 'judge',
      speaker: 'judge',
      content: response.content,
      costUsd: response.costUsd,
    });

    // Parse judge analysis
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in judge response');
      const raw = JSON.parse(jsonMatch[0]) as {
        consensus?: string[];
        contradictions?: Array<{
          topic: string;
          positions: Array<{ model: string; position: string }>;
        }>;
        partial_coverage?: string[];
        unique_insights?: Array<{ model: string; insight: string }>;
        blind_spots?: string[];
      };

      return {
        consensus: raw.consensus ?? [],
        contradictions: raw.contradictions ?? [],
        partialCoverage: raw.partial_coverage ?? [],
        uniqueInsights: raw.unique_insights ?? [],
        blindSpots: raw.blind_spots ?? [],
      };
    } catch (err) {
      log.warn('Failed to parse judge analysis as JSON, returning empty analysis', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return {
        consensus: [],
        contradictions: [],
        partialCoverage: [],
        uniqueInsights: [],
        blindSpots: [],
      };
    }
  }

  private async synthesize(
    analysis: JudgeAnalysis,
    panelResponses: Array<{ model: string; response: string }>,
    task: string,
    context: string,
  ): Promise<string> {
    const { onEvent } = this.config;

    const analysisJson = JSON.stringify(
      {
        consensus: analysis.consensus,
        contradictions: analysis.contradictions,
        partial_coverage: analysis.partialCoverage,
        unique_insights: analysis.uniqueInsights,
        blind_spots: analysis.blindSpots,
      },
      null,
      2,
    );

    const responseSummary = panelResponses
      .map((r, i) => `**Panel ${i + 1} (${r.model}):** ${r.response.slice(0, 500)}...`)
      .join('\n\n');

    const synthesizerSystemPrompt =
      this.config.synthesizerModel?.systemPrompt ??
      'You are an expert synthesizer. Your role is to produce the best possible answer by integrating insights from multiple sources. Ground your answer in the structured analysis provided — prioritize consensus, resolve contradictions with reasoning, incorporate unique insights, and address blind spots where possible.';

    const prompt = `## Original Task\n${task}\n\n## Context\n${context}\n\n## Structured Analysis (from judge)\n${analysisJson}\n\n## Panel Summaries\n${responseSummary}\n\n## Your Task\nProduce the FINAL answer to the original task. Ground your response in the structured analysis:\n- Build on consensus points (high confidence)\n- Resolve contradictions with reasoning\n- Incorporate unique insights where valuable\n- Address blind spots where possible\n\nProvide a clean, integrated answer — not a meta-commentary on the panel.`;

    onEvent?.({
      type: 'phase_start',
      phase: 'synthesize',
      speaker: 'synthesizer',
      model: this.config.synthesizerModel?.model ?? this.config.judgeModel.model,
    });

    const response = await this.synthesizerProvider.call(
      [
        { role: 'system', content: synthesizerSystemPrompt },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.5 },
    );

    this.totalCost += response.costUsd;

    this.transcript.push({
      speaker: 'synthesizer',
      model: response.model,
      phase: 'synthesize',
      content: response.content,
      usage: response.usage,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    onEvent?.({
      type: 'phase_end',
      phase: 'synthesize',
      speaker: 'synthesizer',
      content: response.content,
      costUsd: response.costUsd,
    });

    return response.content;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private budgetExhausted(): boolean {
    return this.totalCost >= this.config.budgetUsd;
  }
}

// ─── Default configuration ─────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are an expert judge in a multi-model fusion panel. Your role is to perform structured comparative analysis of multiple model responses to the same task.

You must produce a JSON analysis with these categories:
- consensus: Points where all or most models agree (high confidence signals)
- contradictions: Direct disagreements, with each model's position stated
- partial_coverage: Topics only some models addressed
- unique_insights: Valuable contributions from individual models not replicated by others
- blind_spots: Important aspects of the task that no model addressed

Be precise and reference specific content. Your analysis drives the final synthesis.`;

/** Default fusion panel: Opus + Gemini + Sonnet, judged by Opus. */
export const DEFAULT_FUSION_CONFIG: Omit<FusionConfig, 'onEvent'> = {
  panelModels: [
    { model: 'claude-opus-4-6' },
    { model: 'gemini-2.5-pro' },
    { model: 'claude-sonnet-4-6' },
  ],
  judgeModel: { model: 'claude-opus-4-6' },
  budgetUsd: 3.0,
};

/** Self-fusion preset: same model twice, cheapest way to get synthesis gains. */
export const SELF_FUSION_CONFIG: Omit<FusionConfig, 'onEvent'> = {
  panelModels: [{ model: 'claude-opus-4-6' }, { model: 'claude-opus-4-6' }],
  judgeModel: { model: 'claude-opus-4-6' },
  budgetUsd: 3.0,
};
