/**
 * Deliberation orchestrator — multi-model adversarial reasoning.
 *
 * Port of mgmt_lib/agents/deliberation.py to TypeScript.
 * Generalized from Trading Rumble's debate engine.
 *
 * Protocol phases:
 * 1. Propose — primary model generates initial output
 * 2. Challenge — adversarial model critiques the proposal
 * 3. Respond — primary model responds, committing to changes or defense
 * 4. Converge — final output incorporating accepted challenges
 */

import { createLogger } from '../logger.js';
import { createProvider } from '../providers/index.js';
import type { ModelProvider } from '../providers/types.js';
import type {
  DeliberationConfig,
  DeliberationResult,
  DeliberationRound,
  TranscriptEntry,
} from './types.js';

const log = createLogger('deliberation');

export class DeliberationOrchestrator {
  private proposerProvider: ModelProvider;
  private challengerProvider: ModelProvider;
  private config: DeliberationConfig;
  private transcript: TranscriptEntry[] = [];
  private totalCost = 0;

  constructor(config: DeliberationConfig) {
    this.config = config;
    this.proposerProvider = createProvider(config.proposer.model);
    this.challengerProvider = createProvider(config.challenger.model);
  }

  async run(task: string, context: string): Promise<DeliberationResult> {
    const { onEvent } = this.config;

    log.info('Starting deliberation', {
      proposer: `${this.config.proposer.name} (${this.config.proposer.model})`,
      challenger: `${this.config.challenger.name} (${this.config.challenger.model})`,
      maxRounds: this.config.maxRounds,
    });

    onEvent?.({ type: 'reasoning_start', mode: 'deliberation', task });

    // Phase 1: Propose
    const proposal = await this.propose(task, context);

    if (this.budgetExhausted()) {
      log.warn('Budget exhausted after proposal, returning as final');
      onEvent?.({ type: 'reasoning_end', mode: 'deliberation', totalCost: this.totalCost });
      return {
        final: proposal,
        proposal,
        rounds: [],
        mindChanges: 0,
        totalCost: this.totalCost,
        transcript: this.transcript,
      };
    }

    // Phase 2-3: Challenge/Respond cycles
    const rounds: DeliberationRound[] = [];
    let currentProposal = proposal;
    let mindChanges = 0;

    for (let roundNum = 1; roundNum <= this.config.maxRounds; roundNum++) {
      log.info(`Round ${roundNum}/${this.config.maxRounds}`);

      // Challenge
      const challenge = await this.challenge(currentProposal, task, context, roundNum);
      if (this.budgetExhausted()) {
        log.warn('Budget exhausted after challenge, stopping');
        break;
      }

      // Respond
      const responseData = await this.respond(currentProposal, challenge, task, context, roundNum);

      const round: DeliberationRound = {
        roundNum,
        challenge,
        response: responseData.response,
        positionChanged: responseData.changed,
        changeDetail: responseData.detail,
      };
      rounds.push(round);

      if (responseData.changed) {
        mindChanges++;
        currentProposal = responseData.revisedProposal;
        log.info(`  Position CHANGED in round ${roundNum}`);
      } else {
        log.info(`  Position HELD in round ${roundNum}`);
      }

      if (this.budgetExhausted()) {
        log.warn('Budget exhausted after response, stopping');
        break;
      }
    }

    // Phase 4: Converge
    const final = await this.converge(proposal, rounds, task, context);

    onEvent?.({ type: 'reasoning_end', mode: 'deliberation', totalCost: this.totalCost });

    log.info('Deliberation complete', {
      mindChanges,
      rounds: rounds.length,
      totalCost: `$${this.totalCost.toFixed(4)}`,
    });

    return {
      final,
      proposal,
      rounds,
      mindChanges,
      totalCost: this.totalCost,
      transcript: this.transcript,
    };
  }

  // ─── Phase implementations ───────────────────────────────────────────────

  private async propose(task: string, context: string): Promise<string> {
    const prompt = `## Context\n${context}\n\n## Task\n${task}\n\n## Your Role\nYou are the proposer in a multi-model deliberation. Generate an initial solution.\nAfter you submit, an adversarial model will critique your proposal. Aim for a\nstrong initial position that can withstand scrutiny.\n\nProvide your proposal below.`;

    return this.callModel(
      this.proposerProvider,
      this.config.proposer,
      prompt,
      'propose',
      this.config.proposer.name,
    );
  }

  private async challenge(
    proposal: string,
    task: string,
    context: string,
    roundNum: number,
  ): Promise<string> {
    const prompt = `## Context\n${context}\n\n## Task\n${task}\n\n## Proposal Under Review\n${proposal}\n\n## Your Role\nYou are the challenger in round ${roundNum} of a multi-model deliberation. Critique the proposal above.\nFocus on:\n- Logical flaws or unsupported claims\n- Missing edge cases or risks\n- Alternative approaches that may be superior\n- Evidence or reasoning gaps\n\nProvide specific, actionable critique. Generic disagreement is not useful.`;

    return this.callModel(
      this.challengerProvider,
      this.config.challenger,
      prompt,
      `challenge-${roundNum}`,
      this.config.challenger.name,
    );
  }

  private async respond(
    proposal: string,
    challenge: string,
    task: string,
    context: string,
    roundNum: number,
  ): Promise<{ response: string; changed: boolean; detail?: string; revisedProposal: string }> {
    const prompt = `## Context\n${context}\n\n## Task\n${task}\n\n## Your Original Proposal\n${proposal}\n\n## Challenge Received\n${challenge}\n\n## Your Role\nRespond to the challenge. You MUST commit: did the challenge change your position?\n"I'll think about it" is not valid. Commit YES or NO.\n\nRespond with a JSON object:\n{\n  "response": "Your defense or acknowledgment",\n  "position_changed": false,\n  "change_detail": null,\n  "revised_proposal": null\n}\n\nIf you ARE changing your position:\n{\n  "response": "Fair point. Adjusting approach.",\n  "position_changed": true,\n  "change_detail": "Specific description of what changed",\n  "revised_proposal": "Full updated proposal incorporating the change"\n}`;

    const rawResponse = await this.callModel(
      this.proposerProvider,
      this.config.proposer,
      prompt,
      `respond-${roundNum}`,
      this.config.proposer.name,
    );

    try {
      // Extract JSON from the response (may be wrapped in markdown code block)
      const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      const data = JSON.parse(jsonMatch[0]) as {
        response?: string;
        position_changed?: boolean;
        change_detail?: string;
        revised_proposal?: string;
      };

      return {
        response: data.response ?? rawResponse,
        changed: data.position_changed ?? false,
        detail: data.change_detail ?? undefined,
        revisedProposal: data.revised_proposal ?? proposal,
      };
    } catch {
      log.warn('Response not valid JSON, treating as held position');
      return { response: rawResponse, changed: false, revisedProposal: proposal };
    }
  }

  private async converge(
    original: string,
    rounds: DeliberationRound[],
    task: string,
    context: string,
  ): Promise<string> {
    const debateSummary = rounds
      .map(
        (r) =>
          `### Round ${r.roundNum}\n**Challenge:** ${r.challenge}\n**Response:** ${r.response}\n**Position changed:** ${r.positionChanged ? 'YES' : 'NO'}\n**Details:** ${r.changeDetail ?? 'N/A'}`,
      )
      .join('\n\n');

    const prompt = `## Context\n${context}\n\n## Task\n${task}\n\n## Your Original Proposal\n${original}\n\n## Debate Summary\n${debateSummary}\n\n## Your Role\nThe deliberation is complete. Produce the FINAL output incorporating any changes\nyou committed to during the debate. This should be a clean, integrated version\n(not a diff or changelog).\n\nProvide the final output below.`;

    return this.callModel(
      this.proposerProvider,
      this.config.proposer,
      prompt,
      'converge',
      this.config.proposer.name,
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async callModel(
    provider: ModelProvider,
    role: { name: string; systemPrompt: string; temperature?: number },
    userMessage: string,
    phase: string,
    speaker: string,
  ): Promise<string> {
    const { onEvent } = this.config;

    onEvent?.({
      type: 'phase_start',
      phase,
      speaker,
      model: provider.name,
    });

    const response = await provider.call(
      [
        { role: 'system', content: role.systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: role.temperature ?? 0.7 },
    );

    this.totalCost += response.costUsd;

    this.transcript.push({
      speaker,
      model: response.model,
      phase,
      content: response.content,
      usage: response.usage,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    onEvent?.({
      type: 'phase_end',
      phase,
      speaker,
      content: response.content,
      costUsd: response.costUsd,
    });

    return response.content;
  }

  private budgetExhausted(): boolean {
    return this.totalCost >= this.config.budgetUsd;
  }
}

// ─── Default configuration ─────────────────────────────────────────────────

/** Default deliberation pair: Opus proposes, Gemini challenges. */
export const DEFAULT_DELIBERATION_CONFIG: Omit<DeliberationConfig, 'onEvent'> = {
  proposer: {
    name: 'architect',
    model: 'claude-opus-4-6',
    systemPrompt:
      'You are a senior software architect. You design robust, well-reasoned solutions. When challenged, you evaluate critique honestly and commit to changes when warranted.',
    temperature: 0.7,
  },
  challenger: {
    name: 'critic',
    model: 'gemini-2.5-pro',
    systemPrompt:
      'You are a critical technical reviewer. Your role is adversarial — find flaws, edge cases, missing considerations, and better alternatives. Be specific and evidence-based.',
    temperature: 0.8,
  },
  maxRounds: 2,
  convergence: 'fixed-rounds',
  budgetUsd: 2.0,
};
