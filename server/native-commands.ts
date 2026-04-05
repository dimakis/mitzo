import type { SkillRegistry } from './skills.js';

export interface NativeCommandResult {
  command: string;
  content: string; // rendered markdown
}

type NativeCommandHandler = (args: string, skillRegistry: SkillRegistry) => NativeCommandResult;

export class NativeCommandRegistry {
  private commands = new Map<string, NativeCommandHandler>();

  constructor() {
    this.commands.set('skills', skillsCommand);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  names(): Set<string> {
    return new Set(this.commands.keys());
  }

  execute(
    name: string,
    args: string,
    skillRegistry: SkillRegistry,
  ): NativeCommandResult | undefined {
    const handler = this.commands.get(name);
    if (!handler) return undefined;
    return handler(args, skillRegistry);
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
