import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';
import type { SessionRegistry } from '../session-registry.js';
import { adaptSdkQuery, parseModelSpec } from '../chat.js';
import { runQueryLoop } from '../query-loop.js';
import { ClaudeTurnAttribution } from '../claude-turn-attribution.js';

const traces = vi.hoisted(() => ({
  spans: () => [] as ReadableSpan[],
  reset: () => {},
}));
vi.mock('../tracing.js', async () => {
  const { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } =
    await import('@opentelemetry/sdk-trace-node');
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  traces.spans = () => exporter.getFinishedSpans();
  traces.reset = () => exporter.reset();
  return { tracer: provider.getTracer('claude-attribution-test') };
});

const release = 'a'.repeat(40);
type Provider = 'anthropic-claude' | 'anthropic-vertex' | 'anthropic-api';
function admission(provider: Provider, accountId: string, model: string) {
  return {
    binding: {
      version: 2,
      account: { accountId, provider, profileRevision: 'profile-revision' },
      harness: { implementation: 'claude-sdk' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target-revision' },
    },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'auto', revision: 1 },
      model,
      thinking: null,
    },
  } satisfies Pick<OrdinaryLocalCommandAdmission, 'binding' | 'selection'>;
}

/** Real SDK message adapter and translator, with only the provider replaced. */
async function emitTrace(attribution: ClaudeTurnAttribution, fail = false) {
  const session = {
    sessionId: undefined,
    currentSnapshot: null,
    observers: new Set(),
    cumulativeSessionTokens: 0,
    cumulativeCostUsd: 0,
    // Mutable UI state must not become resolved runtime attribution.
    model: 'unadmitted-ui-model',
    accountBinding: undefined,
    transport: { send: vi.fn(), isOpen: () => true },
  };
  const registry = {
    get: () => session,
    findBySessionId: () => undefined,
    isAttached: () => true,
    isSuspended: () => false,
    remove: vi.fn(),
  } as unknown as SessionRegistry;
  const query = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'message_start',
          message: { id: 'native-message', model: 'provider-payload-model', secret: 'raw-secret' },
        },
      };
      if (fail) throw Error('offline-provider-failure');
      yield { type: 'stream_event', event: { type: 'message_stop' } };
      yield { type: 'result', is_error: false };
    },
  } as unknown as Query;
  await runQueryLoop(
    adaptSdkQuery(query),
    'client',
    registry,
    new AbortController(),
    undefined,
    undefined,
    { turnTraceAttributes: () => attribution.attributes() },
  );
  return traces.spans().find((span) => span.name === 'turn')!;
}

beforeEach(() => traces.reset());

describe('resolved Claude turn attribution', () => {
  it.each([
    ['anthropic-claude', 'personal', 'claude-opus-4-6:high', 'claude-opus-4-6'],
    ['anthropic-vertex', 'vertex', 'claude-sonnet-4-6:high', 'claude-sonnet-4-6'],
    ['anthropic-api', 'api-one', 'org/model:revision', 'org/model:revision'],
    ['anthropic-api', 'api-two', 'another/model', 'another/model'],
  ] as const)(
    'exports the admitted %s/%s route through the real adapter',
    async (provider, accountId, model, resolvedModel) => {
      const selected = admission(provider, accountId, model);
      const attribution = new ClaudeTurnAttribution(() => 'command', release);
      attribution.select(
        'command',
        selected,
        parseModelSpec(model, provider === 'anthropic-api').model,
      );
      const span = await emitTrace(attribution);
      expect(span.attributes).toMatchObject({
        'mitzo.engine': 'claude-sdk',
        'mitzo.route': provider,
        'mitzo.account.id': accountId,
        'gen_ai.request.model': resolvedModel,
        'mitzo.command.id': 'command',
        'mitzo.release.revision': release,
        'turn.index': 0,
        'turn.message_id': 'native-message',
      });
      expect(span.status.code).toBe(1);
      expect(traces.spans().filter((s) => s.name === 'session')).toHaveLength(1);
      expect(JSON.stringify(span.attributes)).not.toMatch(
        /raw-secret|provider-payload|unadmitted-ui/,
      );
    },
  );

  it('exports explicit unknowns without an admitted selection or release', async () => {
    const span = await emitTrace(new ClaudeTurnAttribution(() => undefined, undefined));
    expect(span.attributes).toMatchObject({
      'mitzo.engine': 'claude-sdk',
      'mitzo.route': 'unknown',
      'mitzo.account.id': 'unknown',
      'gen_ai.request.model': 'unknown',
      'mitzo.command.id': 'unknown',
      'mitzo.release.revision': 'unknown',
    });
  });

  it('retains resolved attribution when the provider fails mid-turn', async () => {
    const attribution = new ClaudeTurnAttribution(() => 'command', release);
    attribution.select('command', admission('anthropic-api', 'api-one', 'model'), 'model');
    const span = await emitTrace(attribution, true);
    expect(span.attributes['mitzo.account.id']).toBe('api-one');
    expect(span.attributes['gen_ai.request.model']).toBe('model');
    // Preserve the translator's existing flush/turn status policy. The session
    // is the existing failure signal; attribution must survive that path.
    expect(traces.spans().find((s) => s.name === 'session')?.status.code).toBe(2);
    expect(traces.spans().filter((s) => s.name === 'turn')).toHaveLength(1);
  });

  it('copies only resolved fields and refuses to lend attribution to a successor', () => {
    let current: string | undefined = 'first';
    const attribution = new ClaudeTurnAttribution(() => current, release);
    const selected = {
      ...admission('anthropic-api', 'api-one', 'model-one'),
      credentials: { apiKey: 'credential-secret' },
      payload: { text: 'private-prompt' },
    };
    attribution.select('first', selected, 'model-one');
    selected.binding.account.accountId = 'mutated-account';
    selected.selection.model = 'mutated-model';
    const first = attribution.attributes();
    expect(first['mitzo.account.id']).toBe('api-one');
    expect(first['gen_ai.request.model']).toBe('model-one');
    expect(JSON.stringify(first)).not.toMatch(/secret|private-prompt|mutated/);
    current = 'second';
    expect(attribution.attributes()['mitzo.account.id']).toBe('unknown');
    attribution.select('second', admission('anthropic-api', 'api-two', 'model-two'), 'model-two');
    expect(attribution.attributes()['gen_ai.request.model']).toBe('model-two');
    expect(first['gen_ai.request.model']).toBe('model-one');
    current = undefined;
    expect(attribution.attributes()['gen_ai.request.model']).toBe('unknown');
  });

  it.each(['', 'bad\nmodel', 'x'.repeat(201)])('uses unknown for invalid metadata %j', (value) => {
    const attribution = new ClaudeTurnAttribution(() => 'command', value);
    attribution.select('command', admission('anthropic-api', value, value), value);
    expect(attribution.attributes()).toMatchObject({
      'mitzo.account.id': 'unknown',
      'gen_ai.request.model': 'unknown',
      'mitzo.release.revision': 'unknown',
    });
  });
});
