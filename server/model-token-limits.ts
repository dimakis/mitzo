import { readFile, stat } from 'node:fs/promises';
import { ModelTokenLimitsSchema, type ModelTokenLimits } from '@mitzo/protocol';

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const own = (value: unknown, key: string) => {
  const record = object(value);
  return Object.hasOwn(record, key) ? record[key] : undefined;
};
const unknown = (model: string, checkedAt?: number): ModelTokenLimits => ({
  model,
  source: 'unknown',
  stale: false,
  ...(checkedAt !== undefined ? { checkedAt } : {}),
});

export function tokenLimitCeiling(limits?: ModelTokenLimits, now = Date.now()): number {
  if (!limits || limits.stale || (limits.expiresAt !== undefined && limits.expiresAt <= now))
    return 0;
  const values = [limits.contextWindow, limits.inputTokenLimit].filter(
    (value): value is number => value !== undefined,
  );
  return values.length ? Math.min(...values) : 0;
}
export function runtimeTokenLimits(
  model: string,
  contextWindow: unknown,
  outputTokenLimit?: unknown,
  checkedAt = Date.now(),
): ModelTokenLimits | undefined {
  const context = positive(contextWindow);
  if (!context) return;
  const output = positive(outputTokenLimit);
  return {
    model,
    source: 'runtime',
    contextWindow: context,
    ...(output ? { outputTokenLimit: output } : {}),
    checkedAt,
    stale: false,
  };
}
export function providerTokenLimits(
  provider: string,
  model: string,
  value: unknown,
  checkedAt = Date.now(),
): ModelTokenLimits | undefined {
  const data = object(value);
  if (typeof data.id === 'string' && data.id !== model) return;
  const claude = provider === 'anthropic' || provider === 'anthropic-vertex';
  const gemini = provider === 'google' || provider === 'google-vertex';
  if (!claude && !gemini) return;
  const input = positive(claude ? data.max_input_tokens : data.inputTokenLimit);
  const output = positive(claude ? data.max_tokens : data.outputTokenLimit);
  if (!input) return;
  return {
    model,
    source: 'provider',
    inputTokenLimit: input,
    ...(output ? { outputTokenLimit: output } : {}),
    checkedAt,
    stale: false,
  };
}

/** Fixed provider namespaces; model IDs are always exact data keys, never inferred aliases. */
const providers: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'anthropic-vertex': 'google-vertex-anthropic',
  'google-vertex': 'google-vertex',
  google: 'google',
};
export class ModelTokenLimitCatalog {
  private data: unknown;
  private checkedAt?: number;
  private attemptedAt?: number;
  private pending?: Promise<void>;
  constructor(
    private load: () => Promise<unknown>,
    private now = Date.now,
    private ttl = 3_600_000,
    private sourceName = 'Catalog',
  ) {}
  private async refresh() {
    const now = this.now();
    if (this.pending) return this.pending;
    // Failed refreshes back off rather than retrying for every streamed message.
    const retryMs = this.checkedAt === this.attemptedAt ? this.ttl : Math.min(this.ttl, 60_000);
    if (this.attemptedAt !== undefined && now - this.attemptedAt < retryMs) return;
    this.attemptedAt = now;
    this.pending = (async () => {
      try {
        const value = await this.load();
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid model limit catalog');
        this.data = value;
        this.checkedAt = now;
      } catch {
        /* Retain the previous snapshot as explicitly stale evidence. */
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
  async resolve(
    provider: string,
    model: string,
    evidence: { runtime?: ModelTokenLimits; providerMetadata?: unknown } = {},
  ): Promise<ModelTokenLimits> {
    const runtime = ModelTokenLimitsSchema.safeParse(evidence.runtime);
    if (
      runtime.success &&
      runtime.data.source === 'runtime' &&
      runtime.data.model === model &&
      tokenLimitCeiling(runtime.data) > 0
    )
      return runtime.data;
    const metadata = providerTokenLimits(provider, model, evidence.providerMetadata, this.now());
    if (metadata) return metadata;
    // A native harness's effective window cannot be inferred from an API model maximum.
    const namespace = own(providers, provider);
    if (typeof namespace !== 'string') return unknown(model);
    await this.refresh();
    const entry = object(own(own(own(this.data, namespace), 'models'), model));
    if (entry.id !== model) return unknown(model, this.checkedAt);
    const limit = object(entry.limit);
    const context = positive(limit.context);
    const input = positive(limit.input);
    const output = positive(limit.output);
    if (!context && !input) return unknown(model, this.checkedAt);
    return {
      model,
      source: 'catalog',
      sourceName: this.sourceName,
      ...(context ? { contextWindow: context } : {}),
      ...(input ? { inputTokenLimit: input } : {}),
      ...(output ? { outputTokenLimit: output } : {}),
      checkedAt: this.checkedAt,
      expiresAt: this.checkedAt !== undefined ? this.checkedAt + this.ttl : undefined,
      stale: this.checkedAt === undefined || this.now() - this.checkedAt >= this.ttl,
    };
  }
}

const CATALOG_URL = 'https://models.dev/api.json';
const MAX_BYTES = 16 * 1024 * 1024;
/** Public metadata only: fixed HTTPS origin, no credentials or prompt/account parameters. */
export async function loadModelTokenLimitCatalog(): Promise<unknown> {
  const file = process.env.MITZO_MODEL_LIMITS_CATALOG_FILE;
  if (file) {
    if ((await stat(file)).size > MAX_BYTES) throw new Error('Model catalog exceeds size limit');
    const bytes = await readFile(file);
    if (bytes.length > MAX_BYTES) throw new Error('Model catalog exceeds size limit');
    return JSON.parse(bytes.toString('utf8'));
  }
  const response = await fetch(CATALOG_URL, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
    credentials: 'omit',
  });
  if (!response.ok || !response.body) throw new Error('Model catalog unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Model catalog exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const catalog = new ModelTokenLimitCatalog(
  loadModelTokenLimitCatalog,
  Date.now,
  3_600_000,
  process.env.MITZO_MODEL_LIMITS_CATALOG_FILE ? 'Configured catalog' : 'Models.dev',
);
export const resolveModelTokenLimits = (provider: string, model: string) =>
  catalog.resolve(provider, model);
