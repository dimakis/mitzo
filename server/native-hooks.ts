import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'] as const;
type Event = (typeof Events)[number];
const Settings = z.object({
  hooks: z
    .record(
      z.string(),
      z.array(
        z.object({
          matcher: z.string().optional(),
          timeout: z.number().positive().max(300).optional(),
          hooks: z.array(z.object({ type: z.literal('command'), command: z.string().min(1) })),
        }),
      ),
    )
    .optional(),
});
interface Result {
  context: string;
  forcePrompt: boolean;
  input?: Record<string, unknown>;
}
const Output = z.object({
  continue: z.boolean().optional(),
  decision: z.string().optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  systemMessage: z.string().optional(),
  additionalContext: z.string().optional(),
  cwd: z.string().optional(),
  hookSpecificOutput: z
    .object({
      permissionDecision: z.enum(['allow', 'ask', 'deny']).optional(),
      permissionDecisionReason: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      additionalContext: z.string().optional(),
    })
    .optional(),
});
/** A bounded native adapter for command hooks. Hook allow decisions never bypass Mitzo policy. */
export class NativeHooks {
  private hooks: NonNullable<z.infer<typeof Settings>['hooks']>;
  constructor(
    private cwd: string,
    private sessionId: string,
    private env: Record<string, string>,
  ) {
    const file = join(cwd, '.claude/settings.json');
    try {
      this.hooks = existsSync(file)
        ? (Settings.parse(JSON.parse(readFileSync(file, 'utf8'))).hooks ?? {})
        : {};
      if (
        Object.entries(this.hooks).some(
          ([event, groups]) => groups.length && !Events.includes(event as Event),
        )
      )
        throw new Error();
      for (const groups of Object.values(this.hooks))
        for (const group of groups) if (group.matcher) new RegExp(group.matcher);
    } catch {
      throw new Error('Project hooks are invalid or use an unsupported native hook event.');
    }
  }
  async run(event: Event, input: Record<string, unknown>, signal: AbortSignal): Promise<Result> {
    const result: Result = { context: '', forcePrompt: false };
    for (const group of this.hooks[event] ?? []) {
      const match = String(input.tool_name ?? input.source ?? input.reason ?? '');
      if (group.matcher && !new RegExp(group.matcher).test(match)) continue;
      for (const hook of group.hooks) {
        signal.throwIfAborted();
        let output: z.infer<typeof Output>;
        try {
          const stdout = await new Promise<string>((resolve, reject) => {
            const child = execFile(
              '/bin/sh',
              ['-c', hook.command],
              {
                cwd: this.cwd,
                env: { ...this.env, CLAUDE_PROJECT_DIR: this.cwd },
                timeout: (group.timeout ?? 60) * 1000,
                maxBuffer: 256 * 1024,
                signal,
              },
              (error, stdout) => (error ? reject(new Error()) : resolve(stdout)),
            );
            child.stdin?.on('error', () => {});
            child.stdin?.end(
              JSON.stringify({
                ...input,
                hook_event_name: event,
                session_id: this.sessionId,
                cwd: this.cwd,
                transcript_path: '',
              }),
            );
          });
          output = stdout.trim() ? Output.parse(JSON.parse(stdout)) : {};
        } catch {
          throw new Error(`Project ${event} hook failed.`);
        }
        signal.throwIfAborted();
        const specific = output.hookSpecificOutput;
        if (
          output.continue === false ||
          output.decision === 'block' ||
          specific?.permissionDecision === 'deny'
        )
          throw new Error(
            specific?.permissionDecisionReason ??
              output.reason ??
              output.stopReason ??
              `Project ${event} hook blocked the action.`,
          );
        if (output.cwd && output.cwd !== this.cwd)
          throw new Error(
            'Project hook requested a different workspace. Native session identity cannot change during startup.',
          );
        result.forcePrompt ||= specific?.permissionDecision === 'ask';
        if (specific?.updatedInput) result.input = specific.updatedInput;
        for (const context of [
          output.systemMessage,
          output.additionalContext,
          specific?.additionalContext,
        ])
          if (context) result.context += `${result.context ? '\n' : ''}${context}`;
      }
    }
    return result;
  }
}
