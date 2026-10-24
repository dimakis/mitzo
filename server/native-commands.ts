import { createHash } from 'node:crypto';
import {
  preparePaidReasoningHarness,
  PaidReasoningSelectionError,
} from './paid-reasoning-harness.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import type { PaidReasoningPhaseSelection } from '@mitzo/protocol';
import { startFusion, parseFusionInput, type FusionRequest } from './fusion-admission.js';
import { loadAccountProfiles } from './account-profiles.js';
import type { SkillRegistry } from './skills.js';
import type { SessionTransport } from '@mitzo/harness';
import {
  DEFAULT_DELIBERATION_CONFIG,
  DEFAULT_FUSION_CONFIG,
  SELF_FUSION_CONFIG,
} from '@mitzo/harness';
import type { ReasoningEvent } from '@mitzo/harness';
import {
  startDeliberation,
  parseDeliberationInput,
  type DeliberationRequest,
} from './deliberate-admission.js';
import type { EventStore } from './event-store.js';
import { ExecutionAdmissionError } from '@mitzo/protocol/event-store';
import { createLogger } from './logger.js';

const log = createLogger('native-commands');

export interface NativeCommandResult {
  command: string;
  content: string; // rendered markdown
}

/** Context available to async native commands. */
export interface NativeCommandContext {
  transport?: SessionTransport;
  paidReasoning?: { operatorConnectionId: string; phaseSelections?: PaidReasoningPhaseSelection[] };
  fusion?: { store: EventStore; request: FusionRequest; onAdmitted: () => void };
  deliberation?: { store: EventStore; request: DeliberationRequest; onAdmitted: () => void };
}

type SyncHandler = (args: string, skillRegistry: SkillRegistry) => NativeCommandResult;
type AsyncHandler = (
  args: string,
  skillRegistry: SkillRegistry,
  ctx: NativeCommandContext,
) => Promise<NativeCommandResult>;

type NativeCommandHandler = SyncHandler | AsyncHandler;

export class NativeCommandRegistry {
  private commands = new Map<string, NativeCommandHandler>();

  constructor() {
    this.commands.set('skills', skillsCommand);
    this.commands.set('models', modelsCommand);
    this.commands.set('close', closeCommand);
    this.commands.set('deliberate', deliberateCommand);
    this.commands.set('fuse', fuseCommand);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  names(): Set<string> {
    return new Set(this.commands.keys());
  }

  /**
   * Execute a native command. Always returns a Promise for uniform handling.
   * Callers must await the result — async handlers (deliberate, fuse) return
   * Promises that would otherwise be silently dropped.
   */
  async execute(
    name: string,
    args: string,
    skillRegistry: SkillRegistry,
    ctx: NativeCommandContext = {},
  ): Promise<NativeCommandResult | undefined> {
    const handler = this.commands.get(name);
    if (!handler) return undefined;
    return handler(args, skillRegistry, ctx);
  }
}

// --- /skills command ---

function skillsCommand(args: string, skillRegistry: SkillRegistry): NativeCommandResult {
  const skills = skillRegistry.list();

  // Specific skill lookup
  if (args.trim()) {
    const name = args.trim();
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      return {
        command: 'skills',
        content: `Skill **/${name}** not found.`,
      };
    }

    const lines = [`**/${skill.name}** (${skill.scope})`, '', skill.description];

    if (skill.allowedTools && skill.allowedTools.length > 0) {
      lines.push('', `**Tools:** ${skill.allowedTools.join(', ')}`);
    }

    if (skill.collisions && skill.collisions.length > 0) {
      lines.push(
        '',
        '**Also defined in:**',
        ...skill.collisions.map((c) => `- ${c.scope}: ${c.description}`),
      );
    }

    return { command: 'skills', content: lines.join('\n') };
  }

  // List all skills
  if (skills.length === 0) {
    return {
      command: 'skills',
      content: 'No skills available. Add skills to `.mitzo/skills/` in your repo.',
    };
  }

  const lines = ['**Available skills:**', ''];
  for (const skill of skills) {
    lines.push(`- **/${skill.name}** (${skill.scope}) — ${skill.description}`);
  }

  return { command: 'skills', content: lines.join('\n') };
}

// --- /close command ---

function closeCommand(): NativeCommandResult {
  return {
    command: 'close',
    content: 'Closing session... The agent will commit any uncommitted work and write a summary.',
  };
}

async function selectedReasoningRuntime(
  ctx: NativeCommandContext,
  roles: string[],
  commandId: string,
) {
  if (!ctx.paidReasoning)
    throw new PaidReasoningSelectionError(
      'Choose explicit account, model, target and output policy selections for every reasoning role using the paid reasoning action.',
    );
  const authorization = captureAgentLibraryAuthorization(ctx.paidReasoning.operatorConnectionId);
  authorization.assertCurrent();
  return preparePaidReasoningHarness({
    roles,
    selections: ctx.paidReasoning.phaseSelections,
    owner: {
      authSessionId: authorization.auth.id,
      operatorConnectionId: ctx.paidReasoning.operatorConnectionId,
    },
    phasePrefix: createHash('sha256').update(commandId).digest('hex').slice(0, 32),
  });
}

// --- /deliberate command ---

async function deliberateCommand(
  args: string,
  _skillRegistry: SkillRegistry,
  ctx: NativeCommandContext,
): Promise<NativeCommandResult> {
  const input = parseDeliberationInput(args);
  if (!input.task) {
    return {
      command: 'deliberate',
      content:
        '**Usage:** `/deliberate <task>`\n\nRuns adversarial multi-model deliberation. ' +
        'Select accounts, models and output policy for proposer and challenger; tracked mind-changes.\n\n' +
        'Example: `/deliberate Should we use Redis or Memcached for our session cache?`',
    };
  }

  if (!ctx.deliberation) throw new Error('Durable deliberation context is required');
  let admitted;
  let config = structuredClone(DEFAULT_DELIBERATION_CONFIG);
  try {
    const runtime = await selectedReasoningRuntime(
      ctx,
      ['proposer', 'challenger'],
      ctx.deliberation.request.clientMsgId,
    );
    config = {
      ...config,
      proposer: {
        ...config.proposer,
        model: runtime.selections.find((phase) => phase.role === 'proposer')!.model,
      },
      challenger: {
        ...config.challenger,
        model: runtime.selections.find((phase) => phase.role === 'challenger')!.model,
      },
    };
    admitted = startDeliberation({
      config,
      createProvider: runtime.createProvider,
      routeRevision: runtime.routeRevision,
      store: ctx.deliberation.store,
      request: {
        ...ctx.deliberation.request,
        task: input.task,
        selection: { ...ctx.deliberation.request.selection, phaseSelections: runtime.selections },
        confirmAmbiguous: input.confirmAmbiguous || ctx.deliberation.request.confirmAmbiguous,
      },
      onEvent: buildEventEmitter(ctx.transport, 'deliberation'),
      onAdmitted: ctx.deliberation.onAdmitted,
    });
  } catch (error) {
    if (error instanceof ExecutionAdmissionError || error instanceof PaidReasoningSelectionError)
      throw error;
    if (error instanceof Error && error.message.startsWith('Explicit confirmation required'))
      throw error;
    // Storage/provider errors can contain private paths or credential material.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Deliberation admission unavailable; no new provider work was started');
  }
  try {
    const outcome = await admitted.completion;
    if (outcome.status !== 'completed' || !outcome.result) {
      const messages = {
        running: 'Deliberation is already running. No provider work was repeated.',
        completed: 'Deliberation already completed. No provider work was repeated.',
        failed: 'Deliberation failed before completion. No provider work was repeated.',
        cancelled: 'Deliberation cancelled. No further phases will run.',
        ambiguous:
          'Deliberation outcome is uncertain. No provider work was repeated. To explicitly start another attempt, use /deliberate --confirm-ambiguous <task>. This may repeat provider work.',
      };
      return { command: 'deliberate', content: messages[outcome.status] };
    }
    const result = outcome.result;
    const roundsSummary = result.rounds
      .map(
        (r) =>
          `**Round ${r.roundNum}:** ${r.positionChanged ? 'Position CHANGED' : 'Position HELD'}` +
          (r.changeDetail ? ` — ${r.changeDetail}` : ''),
      )
      .join('\n');

    const content = [
      `## Deliberation Result`,
      '',
      `**Task:** ${input.task}`,
      `**Proposer:** ${config.proposer.name} (${config.proposer.model})`,
      `**Challenger:** ${config.challenger.name} (${config.challenger.model})`,
      `**Rounds:** ${result.rounds.length} | **Mind changes:** ${result.mindChanges} | **Estimated usage cost:** $${result.totalCost.toFixed(4)}`,
      '',
      '### Debate',
      roundsSummary || '_No rounds completed_',
      '',
      '### Final Output',
      result.final,
    ].join('\n');

    return { command: 'deliberate', content };
  } catch {
    log.error('Deliberation failed', { category: 'durable_execution_failure' });
    return {
      command: 'deliberate',
      content: 'Deliberation failed. Check the durable execution state before retrying.',
    };
  }
}

// --- /fuse command ---

const FUSE_USAGE: NativeCommandResult = {
  command: 'fuse',
  content:
    '**Usage:** `/fuse <task>`\n\nRuns parallel multi-model fusion. ' +
    'Fan-out to 3 models, judge analyzes consensus/contradictions, synthesizer writes final answer.\n\n' +
    'Select an account, model and output policy for each panel, judge and synthesizer role.\n\n' +
    'Options:\n- `/fuse --self <task>` — self-fusion (same selected model x2)\n\n' +
    'Example: `/fuse What are the tradeoffs of event sourcing vs CRUD for our order system?`',
};

async function fuseCommand(
  args: string,
  _skillRegistry: SkillRegistry,
  ctx: NativeCommandContext,
): Promise<NativeCommandResult> {
  const input = parseFusionInput(args);
  const task = input.task;
  if (!task) return FUSE_USAGE;
  if (!ctx.fusion) throw new Error('Durable fusion context is required');
  let admitted;
  const baseline = input.self ? SELF_FUSION_CONFIG : DEFAULT_FUSION_CONFIG;
  let config = structuredClone(baseline);
  try {
    const roles = [
      ...config.panelModels.map((_panel, index) => `panel-${index}`),
      'judge',
      'synthesizer',
    ];
    const runtime = await selectedReasoningRuntime(ctx, roles, ctx.fusion.request.clientMsgId);
    const model = (role: string) => runtime.selections.find((phase) => phase.role === role)!.model;
    if (input.self && model('panel-0') !== model('panel-1'))
      throw new PaidReasoningSelectionError(
        'Self-fusion requires the same explicitly selected model in both panel roles; their selected accounts may differ.',
      );
    config = {
      ...config,
      panelModels: config.panelModels.map((panel, index) => ({
        ...panel,
        model: model(`panel-${index}`),
      })),
      judgeModel: { ...config.judgeModel, model: model('judge') },
      synthesizerModel: { ...config.synthesizerModel, model: model('synthesizer') },
    };
    admitted = startFusion({
      createProvider: runtime.createProvider,
      routeRevision: runtime.routeRevision,
      store: ctx.fusion.store,
      request: {
        ...ctx.fusion.request,
        task,
        selection: { ...ctx.fusion.request.selection, phaseSelections: runtime.selections },
        confirmAmbiguous: input.confirmAmbiguous || ctx.fusion.request.confirmAmbiguous,
      },
      config,
      onEvent: buildEventEmitter(ctx.transport, 'fusion'),
      onAdmitted: ctx.fusion.onAdmitted,
    });
  } catch (error) {
    if (error instanceof ExecutionAdmissionError || error instanceof PaidReasoningSelectionError)
      throw error;
    if (error instanceof Error && error.message.startsWith('Explicit confirmation required'))
      throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Fusion admission unavailable; no new provider work was started');
  }
  try {
    const outcome = await admitted.completion;
    if (outcome.status !== 'completed' || !outcome.result) {
      const messages = {
        running: 'Fusion is already running. No provider work was repeated.',
        completed: 'Fusion already completed. No provider work was repeated.',
        failed: 'Fusion failed before completion. No provider work was repeated.',
        cancelled: 'Fusion cancelled. No further phases will run.',
        ambiguous:
          'Fusion outcome is uncertain. No provider work was repeated. To explicitly start another attempt, use /fuse --confirm-ambiguous <task> (include --self for self-fusion). This may repeat provider work.',
      };
      return { command: 'fuse', content: messages[outcome.status] };
    }
    const result = outcome.result;

    const panelSummary = result.panelResponses
      .map((r, i) => `**Panel ${i + 1}** (${r.model}): ${r.response.slice(0, 200)}...`)
      .join('\n\n');

    const analysisSummary = [
      result.judgeAnalysis.consensus.length > 0
        ? `**Consensus (${result.judgeAnalysis.consensus.length}):** ${result.judgeAnalysis.consensus.join('; ')}`
        : null,
      result.judgeAnalysis.contradictions.length > 0
        ? `**Contradictions (${result.judgeAnalysis.contradictions.length}):** ${result.judgeAnalysis.contradictions.map((c) => c.topic).join('; ')}`
        : null,
      result.judgeAnalysis.uniqueInsights.length > 0
        ? `**Unique insights (${result.judgeAnalysis.uniqueInsights.length}):** ${result.judgeAnalysis.uniqueInsights.map((u) => `${u.model}: ${u.insight}`).join('; ')}`
        : null,
      result.judgeAnalysis.blindSpots.length > 0
        ? `**Blind spots:** ${result.judgeAnalysis.blindSpots.join('; ')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const content = [
      `## Fusion Result`,
      '',
      `**Task:** ${task}`,
      `**Panel:** ${result.panelResponses.map((r) => r.model).join(', ')}`,
      `**Estimated usage cost:** $${result.totalCost.toFixed(4)}`,
      '',
      '### Judge Analysis',
      analysisSummary || '_No analysis available_',
      '',
      '### Panel Responses',
      panelSummary,
      '',
      '### Synthesized Output',
      result.finalOutput,
    ].join('\n');

    return { command: 'fuse', content };
  } catch {
    log.error('Fusion failed', { category: 'durable_execution_failure' });
    return {
      command: 'fuse',
      content: 'Fusion failed. Check the durable execution state before retrying.',
    };
  }
}

// --- Helpers ---

/**
 * Build an event emitter that streams reasoning events over the WS transport.
 * Events are sent as `reasoning_event` messages for the frontend to render.
 */
function buildEventEmitter(
  transport: SessionTransport | undefined,
  mode: 'deliberation' | 'fusion',
): (event: ReasoningEvent) => void {
  return (event: ReasoningEvent) => {
    if (transport) {
      transport.send({
        type: 'reasoning_event',
        v: 2,
        mode,
        event,
      });
    }
  };
}

async function modelsCommand(args: string): Promise<NativeCommandResult> {
  if (args.trim() && args.trim() !== 'refresh')
    return { command: 'models', content: 'Usage: `/models` or `/models refresh`.' };
  try {
    const profiles = loadAccountProfiles();
    await profiles.refresh(args.trim() === 'refresh');
    const lines = profiles.catalog().map((account) => {
      const status = account.modelDiscovery.stale
        ? ' (refresh failed; showing the last available list)'
        : '';
      return `**${account.label}**${status}\n${account.models.map((model) => `- ${model.label} (${model.id})`).join('\n')}`;
    });
    return { command: 'models', content: lines.join('\n\n') || 'No account profiles configured.' };
  } catch {
    return {
      command: 'models',
      content: 'Model discovery unavailable. Check the account configuration and retry.',
    };
  }
}
