import type { Context, Span } from '@opentelemetry/api';
import { tracer } from './tracing.js';
import { timingObservation } from './command-timing-trace.js';

const activityItems = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageView',
  'subAgentActivity',
  'collabAgentToolCall',
]);

/** Called only after the conversation validates the original thread and turn. */
export class CodexOutputTiming {
  private activity?: Span;
  private text?: Span;
  constructor(parent: Context) {
    timingObservation('first_activity_start', () => {
      this.activity = tracer.startSpan('codex.turn.first_activity', {}, parent);
    });
    timingObservation('first_text_start', () => {
      this.text = tracer.startSpan('codex.turn.first_text', {}, parent);
    });
  }
  observe(method: string, params: Record<string, unknown>) {
    const text =
      method === 'item/agentMessage/delta' &&
      typeof params.delta === 'string' &&
      params.delta.length > 0;
    const reasoning =
      ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method) &&
      typeof params.delta === 'string' &&
      params.delta.length > 0;
    const item = params.item as { type?: string; text?: string } | undefined;
    const completedText =
      method === 'item/completed' &&
      item?.type === 'agentMessage' &&
      typeof item.text === 'string' &&
      item.text.length > 0;
    const tool =
      ['item/started', 'item/completed'].includes(method) && activityItems.has(item?.type ?? '');
    if (text || reasoning || completedText || tool) this.finish('activity', 'output');
    if (text || completedText) this.finish('text', 'output');
  }
  close(result: 'terminal_before_output' | 'failed_before_output') {
    this.finish('activity', result);
    this.finish('text', result);
  }
  private finish(kind: 'activity' | 'text', result: string) {
    const span = this[kind];
    this[kind] = undefined;
    if (!span) return;
    timingObservation(`first_${kind}_result`, () =>
      span.setAttribute(`mitzo.first_${kind}.result`, result),
    );
    timingObservation(`first_${kind}_end`, () => span.end());
  }
}
