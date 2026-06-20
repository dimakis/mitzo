import { describe, it, expect } from 'vitest';
import {
  buildDeliberationConfig,
  buildDeliberationConfigFromAgent,
  buildFusionConfig,
} from '../src/reasoning/schema-loader.js';
import type { AgentDefinitionInput } from '../src/reasoning/schema-loader.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const proposerDef: AgentDefinitionInput = {
  identity: {
    name: 'deliberation-architect',
    description: 'Proposes architectural solutions',
  },
  provider: { default: 'claude-opus-4-6' },
  deliberation: {
    role: 'proposer',
    counterpart: 'deliberation-challenger',
    protocol: {
      phases: ['propose', 'challenge', 'respond', 'converge'],
      max_rounds: 3,
      convergence: 'fixed-rounds',
    },
  },
};

const challengerDef: AgentDefinitionInput = {
  identity: {
    name: 'deliberation-challenger',
    description: 'Critiques architectural proposals',
  },
  provider: { default: 'gemini-2.5-pro' },
  deliberation: {
    role: 'challenger',
    counterpart: 'deliberation-architect',
    protocol: {
      phases: ['propose', 'challenge', 'respond', 'converge'],
      max_rounds: 3,
      convergence: 'fixed-rounds',
    },
  },
};

// ─── buildDeliberationConfig ────────────────────────────────────────────────

describe('buildDeliberationConfig', () => {
  it('builds config from proposer + challenger pair', () => {
    const config = buildDeliberationConfig(proposerDef, challengerDef);

    expect(config.proposer.name).toBe('deliberation-architect');
    expect(config.proposer.model).toBe('claude-opus-4-6');
    expect(config.challenger.name).toBe('deliberation-challenger');
    expect(config.challenger.model).toBe('gemini-2.5-pro');
    expect(config.maxRounds).toBe(3);
    expect(config.convergence).toBe('fixed-rounds');
    expect(config.budgetUsd).toBe(2.0);
  });

  it('uses default system prompts when not overridden', () => {
    const config = buildDeliberationConfig(proposerDef, challengerDef);

    expect(config.proposer.systemPrompt).toContain('architect');
    expect(config.challenger.systemPrompt).toContain('adversarial');
  });

  it('applies option overrides', () => {
    const config = buildDeliberationConfig(proposerDef, challengerDef, {
      budgetUsd: 5.0,
      proposerPrompt: 'Custom proposer prompt',
      challengerPrompt: 'Custom challenger prompt',
      proposerTemperature: 0.5,
      challengerTemperature: 0.9,
    });

    expect(config.budgetUsd).toBe(5.0);
    expect(config.proposer.systemPrompt).toBe('Custom proposer prompt');
    expect(config.challenger.systemPrompt).toBe('Custom challenger prompt');
    expect(config.proposer.temperature).toBe(0.5);
    expect(config.challenger.temperature).toBe(0.9);
  });

  it('uses defaults when neither agent specifies protocol', () => {
    const proposerNoProtocol: AgentDefinitionInput = {
      ...proposerDef,
      deliberation: {
        role: 'proposer',
        counterpart: 'deliberation-challenger',
      },
    };

    const challengerNoProtocol: AgentDefinitionInput = {
      ...challengerDef,
      deliberation: {
        role: 'challenger',
        counterpart: 'deliberation-architect',
      },
    };

    const config = buildDeliberationConfig(proposerNoProtocol, challengerNoProtocol);

    expect(config.maxRounds).toBe(2);
    expect(config.convergence).toBe('fixed-rounds');
  });

  it('falls back to challenger protocol when proposer has none', () => {
    const proposerNoProtocol: AgentDefinitionInput = {
      ...proposerDef,
      deliberation: {
        role: 'proposer',
        counterpart: 'deliberation-challenger',
      },
    };

    const config = buildDeliberationConfig(proposerNoProtocol, challengerDef);

    // Should use challenger's protocol settings
    expect(config.maxRounds).toBe(3);
    expect(config.convergence).toBe('fixed-rounds');
  });

  it('throws if proposer has no deliberation block', () => {
    const noDel: AgentDefinitionInput = {
      identity: { name: 'plain-agent', description: 'No deliberation' },
      provider: { default: 'claude-opus-4-6' },
    };

    expect(() => buildDeliberationConfig(noDel, challengerDef)).toThrow(
      'has no deliberation block',
    );
  });

  it('throws if challenger has no deliberation block', () => {
    const noDel: AgentDefinitionInput = {
      identity: { name: 'plain-agent', description: 'No deliberation' },
      provider: { default: 'gemini-2.5-pro' },
    };

    expect(() => buildDeliberationConfig(proposerDef, noDel)).toThrow('has no deliberation block');
  });

  it('throws if proposer has wrong role', () => {
    const wrongRole: AgentDefinitionInput = {
      ...proposerDef,
      deliberation: { ...proposerDef.deliberation!, role: 'challenger' },
    };

    expect(() => buildDeliberationConfig(wrongRole, challengerDef)).toThrow('expected "proposer"');
  });

  it('throws if challenger has wrong role', () => {
    const wrongRole: AgentDefinitionInput = {
      ...challengerDef,
      deliberation: { ...challengerDef.deliberation!, role: 'proposer' },
    };

    expect(() => buildDeliberationConfig(proposerDef, wrongRole)).toThrow('expected "challenger"');
  });

  it('warns but does not throw on counterpart name mismatch', () => {
    const mismatchedProposer: AgentDefinitionInput = {
      ...proposerDef,
      deliberation: {
        ...proposerDef.deliberation!,
        counterpart: 'some-other-agent',
      },
    };

    const mismatchedChallenger: AgentDefinitionInput = {
      ...challengerDef,
      deliberation: {
        ...challengerDef.deliberation!,
        counterpart: 'some-other-agent',
      },
    };

    // Should not throw — mismatched counterparts are a warning, not an error
    const config = buildDeliberationConfig(mismatchedProposer, mismatchedChallenger);
    expect(config.proposer.name).toBe('deliberation-architect');
    expect(config.challenger.name).toBe('deliberation-challenger');
  });
});

// ─── buildDeliberationConfigFromAgent ───────────────────────────────────────

describe('buildDeliberationConfigFromAgent', () => {
  it('resolves counterpart and builds config from proposer', async () => {
    const resolve = async (name: string) => {
      if (name === 'deliberation-challenger') return challengerDef;
      throw new Error(`Unknown agent: ${name}`);
    };

    const config = await buildDeliberationConfigFromAgent(proposerDef, resolve);

    expect(config.proposer.name).toBe('deliberation-architect');
    expect(config.challenger.name).toBe('deliberation-challenger');
  });

  it('resolves counterpart and builds config from challenger', async () => {
    const resolve = async (name: string) => {
      if (name === 'deliberation-architect') return proposerDef;
      throw new Error(`Unknown agent: ${name}`);
    };

    const config = await buildDeliberationConfigFromAgent(challengerDef, resolve);

    // Should swap — proposer first regardless of input order
    expect(config.proposer.name).toBe('deliberation-architect');
    expect(config.challenger.name).toBe('deliberation-challenger');
  });

  it('throws if agent has no deliberation block', async () => {
    const noDel: AgentDefinitionInput = {
      identity: { name: 'plain-agent', description: 'No deliberation' },
      provider: { default: 'claude-opus-4-6' },
    };

    await expect(buildDeliberationConfigFromAgent(noDel, async () => proposerDef)).rejects.toThrow(
      'has no deliberation block',
    );
  });

  it('passes options through to buildDeliberationConfig', async () => {
    const resolve = async () => challengerDef;

    const config = await buildDeliberationConfigFromAgent(proposerDef, resolve, {
      budgetUsd: 10.0,
    });

    expect(config.budgetUsd).toBe(10.0);
  });

  it('propagates resolver rejection', async () => {
    const resolve = async (): Promise<AgentDefinitionInput> => {
      throw new Error('ContexGin unreachable');
    };

    await expect(buildDeliberationConfigFromAgent(proposerDef, resolve)).rejects.toThrow(
      'ContexGin unreachable',
    );
  });

  it('throws when resolved counterpart has wrong role', async () => {
    // Resolver returns another proposer instead of a challenger
    const anotherProposer: AgentDefinitionInput = {
      identity: { name: 'another-proposer', description: 'Also proposes' },
      provider: { default: 'claude-sonnet-4-6' },
      deliberation: {
        role: 'proposer',
        counterpart: 'deliberation-architect',
      },
    };

    const resolve = async () => anotherProposer;

    await expect(buildDeliberationConfigFromAgent(proposerDef, resolve)).rejects.toThrow(
      'expected "challenger"',
    );
  });
});

// ─── buildFusionConfig ──────────────────────────────────────────────────────

describe('buildFusionConfig', () => {
  it('builds config from model name list', () => {
    const config = buildFusionConfig(['claude-opus-4-6', 'gemini-2.5-pro', 'claude-sonnet-4-6']);

    expect(config.panelModels).toHaveLength(3);
    expect(config.panelModels[0].model).toBe('claude-opus-4-6');
    expect(config.judgeModel.model).toBe('claude-opus-4-6'); // defaults to first
    expect(config.budgetUsd).toBe(3.0);
    expect(config.synthesizerModel).toBeUndefined();
  });

  it('allows custom judge and synthesizer', () => {
    const config = buildFusionConfig(['claude-opus-4-6', 'gemini-2.5-pro'], {
      judgeModel: 'gemini-2.5-pro',
      synthesizerModel: 'claude-opus-4-6',
    });

    expect(config.judgeModel.model).toBe('gemini-2.5-pro');
    expect(config.synthesizerModel?.model).toBe('claude-opus-4-6');
  });

  it('allows custom budget', () => {
    const config = buildFusionConfig(['claude-opus-4-6', 'gemini-2.5-pro'], {
      budgetUsd: 5.0,
    });

    expect(config.budgetUsd).toBe(5.0);
  });

  it('throws if fewer than 2 models', () => {
    expect(() => buildFusionConfig(['claude-opus-4-6'])).toThrow('at least 2 panel models');
  });

  it('throws on empty array', () => {
    expect(() => buildFusionConfig([])).toThrow('at least 2 panel models');
  });

  it('allows judge model that is not in the panel list', () => {
    const config = buildFusionConfig(['claude-opus-4-6', 'gemini-2.5-pro'], {
      judgeModel: 'claude-sonnet-4-6',
    });

    expect(config.judgeModel.model).toBe('claude-sonnet-4-6');
    expect(config.panelModels).toHaveLength(2);
    // Judge is not in panel — this is allowed behavior
    expect(config.panelModels.map((p) => p.model)).not.toContain('claude-sonnet-4-6');
  });
});
