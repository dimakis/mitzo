/**
 * Schema loader — converts Centaur agent definition YAML into
 * DeliberationConfig and FusionConfig for the reasoning orchestrators.
 *
 * Centaur agent definitions describe deliberation participants declaratively:
 *
 *   deliberation:
 *     role: proposer | challenger
 *     counterpart: deliberation-challenger
 *     protocol:
 *       phases: [propose, challenge, respond, converge]
 *       max_rounds: 2
 *       convergence: fixed-rounds
 *
 * This module resolves a proposer + challenger pair into a ready-to-run
 * DeliberationConfig, pulling model names from each agent's provider block
 * and applying sensible defaults for system prompts and budget.
 */

import { createLogger } from '../logger.js';
import type { AgentRole, DeliberationConfig, FusionConfig, PanelMember } from './types.js';

const log = createLogger('schema-loader');

// ─── Centaur agent definition types (subset we consume) ───────────────────

/** The deliberation block from a Centaur agent definition. */
export interface AgentDeliberationBlock {
  role: 'proposer' | 'challenger';
  counterpart: string;
  protocol?: {
    phases?: string[];
    max_rounds?: number;
    convergence?: 'fixed-rounds' | 'explicit-agreement';
  };
}

/** Minimal agent definition shape we need for config resolution. */
export interface AgentDefinitionInput {
  identity: {
    name: string;
    description: string;
  };
  provider: {
    default: string;
  };
  deliberation?: AgentDeliberationBlock;
}

// ─── Deliberation config builder ──────────────────────────────────────────

/** Default system prompts when the agent definition doesn't specify one. */
const DEFAULT_PROPOSER_PROMPT =
  'You are a senior software architect. You design robust, well-reasoned solutions. When challenged, you evaluate critique honestly and commit to changes when warranted.';

const DEFAULT_CHALLENGER_PROMPT =
  'You are a critical technical reviewer. Your role is adversarial — find flaws, edge cases, missing considerations, and better alternatives. Be specific and evidence-based.';

/** Default budget when not specified. */
const DEFAULT_BUDGET_USD = 2.0;

export interface BuildDeliberationConfigOptions {
  /** Override budget (USD). */
  budgetUsd?: number;
  /** Override proposer system prompt. */
  proposerPrompt?: string;
  /** Override challenger system prompt. */
  challengerPrompt?: string;
  /** Override proposer temperature. */
  proposerTemperature?: number;
  /** Override challenger temperature. */
  challengerTemperature?: number;
}

/**
 * Build a DeliberationConfig from a proposer + challenger agent definition pair.
 *
 * Both definitions must have a `deliberation` block. The proposer's protocol
 * settings take precedence when they differ.
 *
 * @throws if either definition is missing the deliberation block or has the wrong role.
 */
export function buildDeliberationConfig(
  proposerDef: AgentDefinitionInput,
  challengerDef: AgentDefinitionInput,
  options: BuildDeliberationConfigOptions = {},
): Omit<DeliberationConfig, 'onEvent'> {
  // Validate deliberation blocks
  if (!proposerDef.deliberation) {
    throw new Error(`Agent "${proposerDef.identity.name}" has no deliberation block`);
  }
  if (!challengerDef.deliberation) {
    throw new Error(`Agent "${challengerDef.identity.name}" has no deliberation block`);
  }
  if (proposerDef.deliberation.role !== 'proposer') {
    throw new Error(
      `Agent "${proposerDef.identity.name}" has role "${proposerDef.deliberation.role}", expected "proposer"`,
    );
  }
  if (challengerDef.deliberation.role !== 'challenger') {
    throw new Error(
      `Agent "${challengerDef.identity.name}" has role "${challengerDef.deliberation.role}", expected "challenger"`,
    );
  }

  // Validate counterpart references
  if (proposerDef.deliberation.counterpart !== challengerDef.identity.name) {
    log.warn('Proposer counterpart mismatch', {
      expected: proposerDef.deliberation.counterpart,
      actual: challengerDef.identity.name,
    });
  }
  if (challengerDef.deliberation.counterpart !== proposerDef.identity.name) {
    log.warn('Challenger counterpart mismatch', {
      expected: challengerDef.deliberation.counterpart,
      actual: proposerDef.identity.name,
    });
  }

  // Extract protocol settings (proposer's take precedence)
  const protocol = proposerDef.deliberation.protocol ?? challengerDef.deliberation.protocol ?? {};
  const maxRounds = protocol.max_rounds ?? 2;
  const convergence = protocol.convergence ?? 'fixed-rounds';

  const proposer: AgentRole = {
    name: proposerDef.identity.name,
    model: proposerDef.provider.default,
    systemPrompt: options.proposerPrompt ?? DEFAULT_PROPOSER_PROMPT,
    temperature: options.proposerTemperature ?? 0.7,
  };

  const challenger: AgentRole = {
    name: challengerDef.identity.name,
    model: challengerDef.provider.default,
    systemPrompt: options.challengerPrompt ?? DEFAULT_CHALLENGER_PROMPT,
    temperature: options.challengerTemperature ?? 0.8,
  };

  log.info('Built deliberation config from agent definitions', {
    proposer: `${proposer.name} (${proposer.model})`,
    challenger: `${challenger.name} (${challenger.model})`,
    maxRounds,
    convergence,
  });

  return {
    proposer,
    challenger,
    maxRounds,
    convergence,
    budgetUsd: options.budgetUsd ?? DEFAULT_BUDGET_USD,
  };
}

// ─── Single-definition convenience ────────────────────────────────────────

/**
 * Build a DeliberationConfig from a single agent definition.
 *
 * Resolves the counterpart by name using the provided resolver function.
 * This is the typical path — the caller has one definition and needs to
 * look up its counterpart from the same source (ContexGin, local files, etc).
 */
export async function buildDeliberationConfigFromAgent(
  agentDef: AgentDefinitionInput,
  resolveCounterpart: (name: string) => Promise<AgentDefinitionInput>,
  options: BuildDeliberationConfigOptions = {},
): Promise<Omit<DeliberationConfig, 'onEvent'>> {
  if (!agentDef.deliberation) {
    throw new Error(`Agent "${agentDef.identity.name}" has no deliberation block`);
  }

  const counterpartName = agentDef.deliberation.counterpart;
  const counterpartDef = await resolveCounterpart(counterpartName);

  // Determine which is proposer and which is challenger
  if (agentDef.deliberation.role === 'proposer') {
    return buildDeliberationConfig(agentDef, counterpartDef, options);
  } else {
    return buildDeliberationConfig(counterpartDef, agentDef, options);
  }
}

// ─── Fusion config builder ────────────────────────────────────────────────

export interface BuildFusionConfigOptions {
  /** Override budget (USD). */
  budgetUsd?: number;
  /** Override judge model (defaults to first panel model). */
  judgeModel?: string;
  /** Optional synthesizer model. If omitted, no separate synthesis step is performed. */
  synthesizerModel?: string;
}

/**
 * Build a FusionConfig from a list of model names.
 *
 * Fusion doesn't use Centaur agent definitions (it's model-level, not
 * agent-level), but this helper provides consistent config construction.
 */
export function buildFusionConfig(
  panelModels: string[],
  options: BuildFusionConfigOptions = {},
): Omit<FusionConfig, 'onEvent'> {
  if (panelModels.length < 2) {
    throw new Error('Fusion requires at least 2 panel models');
  }

  const panel: PanelMember[] = panelModels.map((model) => ({ model }));
  const judgeModel = options.judgeModel ?? panelModels[0];

  const config: Omit<FusionConfig, 'onEvent'> = {
    panelModels: panel,
    judgeModel: { model: judgeModel },
    budgetUsd: options.budgetUsd ?? 3.0,
  };

  if (options.synthesizerModel) {
    config.synthesizerModel = { model: options.synthesizerModel };
  }

  log.info('Built fusion config', {
    panelSize: panel.length,
    panelModels,
    judgeModel,
  });

  return config;
}
