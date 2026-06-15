import type { SkillRegistry } from './skills.js';
import type { SessionTransport } from '@mitzo/harness';
import {
  DeliberationOrchestrator,
  FusionOrchestrator,
  DEFAULT_DELIBERATION_CONFIG,
  DEFAULT_FUSION_CONFIG,
  SELF_FUSION_CONFIG,
} from '@mitzo/harness';
import type { ReasoningEvent } from '@mitzo/harness';
import { createLogger } from './logger.js';

const log = createLogger('native-commands');

export interface NativeCommandResult {
  command: string;
  content: string; // rendered markdown
}

/** Context available to async native commands. */
export interface NativeCommandContext {
  transport?: SessionTransport;
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

// --- /deliberate command ---

async function deliberateCommand(
  args: string,
  _skillRegistry: SkillRegistry,
  ctx: NativeCommandContext,
): Promise<NativeCommandResult> {
  if (!args.trim()) {
    return {
      command: 'deliberate',
      content:
        '**Usage:** `/deliberate <task>`\n\nRuns adversarial multi-model deliberation. ' +
        'Opus proposes, Gemini challenges, tracked mind-changes.\n\n' +
        'Example: `/deliberate Should we use Redis or Memcached for our session cache?`',
    };
  }

  const onEvent = buildEventEmitter(ctx.transport, 'deliberation');

  try {
    const orchestrator = new DeliberationOrchestrator({
      ...DEFAULT_DELIBERATION_CONFIG,
      onEvent,
    });

    const result = await orchestrator.run(args.trim(), '');

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
      `**Task:** ${args.trim()}`,
      `**Proposer:** ${DEFAULT_DELIBERATION_CONFIG.proposer.name} (${DEFAULT_DELIBERATION_CONFIG.proposer.model})`,
      `**Challenger:** ${DEFAULT_DELIBERATION_CONFIG.challenger.name} (${DEFAULT_DELIBERATION_CONFIG.challenger.model})`,
      `**Rounds:** ${result.rounds.length} | **Mind changes:** ${result.mindChanges} | **Cost:** $${result.totalCost.toFixed(4)}`,
      '',
      '### Debate',
      roundsSummary || '_No rounds completed_',
      '',
      '### Final Output',
      result.final,
    ].join('\n');

    return { command: 'deliberate', content };
  } catch (err) {
    log.error('Deliberation failed', { error: err instanceof Error ? err.message : 'unknown' });
    return {
      command: 'deliberate',
      content: `Deliberation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

// --- /fuse command ---

async function fuseCommand(
  args: string,
  _skillRegistry: SkillRegistry,
  ctx: NativeCommandContext,
): Promise<NativeCommandResult> {
  if (!args.trim()) {
    return {
      command: 'fuse',
      content:
        '**Usage:** `/fuse <task>`\n\nRuns parallel multi-model fusion. ' +
        'Fan-out to 3 models, judge analyzes consensus/contradictions, synthesizer writes final answer.\n\n' +
        'Options:\n- `/fuse --self <task>` — self-fusion (same model x2, cheapest)\n\n' +
        'Example: `/fuse What are the tradeoffs of event sourcing vs CRUD for our order system?`',
    };
  }

  // Parse --self flag
  let task = args.trim();
  let fusionConfig = DEFAULT_FUSION_CONFIG;
  if (task === '--self' || task.startsWith('--self ')) {
    task = task.slice('--self'.length).trim();
    fusionConfig = SELF_FUSION_CONFIG;
  }

  if (!task) {
    return {
      command: 'fuse',
      content:
        '**Usage:** `/fuse <task>`\n\nRuns parallel multi-model fusion. ' +
        'Fan-out to 3 models, judge analyzes consensus/contradictions, synthesizer writes final answer.\n\n' +
        'Options:\n- `/fuse --self <task>` — self-fusion (same model x2, cheapest)\n\n' +
        'Example: `/fuse What are the tradeoffs of event sourcing vs CRUD for our order system?`',
    };
  }

  const onEvent = buildEventEmitter(ctx.transport, 'fusion');

  try {
    const orchestrator = new FusionOrchestrator({
      ...fusionConfig,
      onEvent,
    });

    const result = await orchestrator.run(task, '');

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
      `**Cost:** $${result.totalCost.toFixed(4)}`,
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
  } catch (err) {
    log.error('Fusion failed', { error: err instanceof Error ? err.message : 'unknown' });
    return {
      command: 'fuse',
      content: `Fusion failed: ${err instanceof Error ? err.message : 'unknown error'}`,
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
