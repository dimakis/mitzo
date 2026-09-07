import { z } from 'zod';

export const CatalogModel = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultReasoningEffort: z.string().optional(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;
const Page = z.object({
  data: z.array(
    z.object({
      model: z.string().min(1),
      displayName: z.string().min(1),
      supportedReasoningEfforts: z
        .array(z.object({ reasoningEffort: z.string().min(1) }))
        .default([]),
      defaultReasoningEffort: z.string().optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
export async function readCodexModels(client: {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}): Promise<CatalogModel[]> {
  const models = new Map<string, CatalogModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = Page.parse(
      await client.request('model/list', {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const m of page.data)
      models.set(m.model, {
        id: m.model,
        label: m.displayName,
        reasoningEfforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        defaultReasoningEffort: m.defaultReasoningEffort,
      });
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor))
      throw new Error('Model discovery pagination did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!models.size) throw new Error('No models returned by account');
  return [...models.values()];
}

// Keyed by the entire profile, so changing credentials/configuration never reuses another account's catalog.
const cache = new Map<
  string,
  { models?: CatalogModel[]; updatedAt?: number; error?: boolean; pending?: Promise<void> }
>();
export function cachedModels(key: string) {
  return cache.get(key);
}
export async function refreshModels(
  key: string,
  discover: () => Promise<CatalogModel[]>,
  force = false,
) {
  const entry = cache.get(key) ?? {};
  cache.set(key, entry);
  if (entry.pending) return entry.pending;
  if (!force && entry.updatedAt && Date.now() - entry.updatedAt < 60 * 60 * 1000) return;
  entry.pending = (async () => {
    try {
      entry.models = z
        .array(CatalogModel)
        .min(1)
        .parse(await discover());
      entry.updatedAt = Date.now();
      entry.error = false;
    } catch {
      entry.error = true;
    } finally {
      entry.pending = undefined;
    }
  })();
  return entry.pending;
}
