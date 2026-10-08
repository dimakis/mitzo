import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CatalogModel } from './model-catalog.js';

const ordinaryEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const frontierEfforts = [...ordinaryEfforts, 'ultra'];
/** Availability comes from this account; labels and capability bounds remain code-owned. */
export const REVIEWED_OPENAI_ENROLLMENT_MODELS: readonly CatalogModel[] = Object.freeze(
  [
    { id: 'gpt-6.1-sol', label: 'Sol 6.1', reasoningEfforts: frontierEfforts },
    { id: 'gpt-6-astra', label: 'Astra 6', reasoningEfforts: frontierEfforts },
    { id: 'gpt-6-sol', label: 'Sol 6', reasoningEfforts: frontierEfforts },
    { id: 'gpt-6-luna', label: 'Luna 6', reasoningEfforts: ordinaryEfforts },
    { id: 'gpt-5.6-sol', label: 'Sol 5.6', reasoningEfforts: frontierEfforts },
    { id: 'gpt-5.6-terra', label: 'Terra 5.6', reasoningEfforts: frontierEfforts },
    { id: 'gpt-5.6-luna', label: 'Luna 5.6', reasoningEfforts: ordinaryEfforts },
    { id: 'gpt-5.4', label: 'GPT-5.4', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
    {
      id: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
  ].map((model) => {
    const reviewed = { ...model, reasoningEfforts: [...model.reasoningEfforts] };
    Object.freeze(reviewed.reasoningEfforts);
    return Object.freeze(reviewed);
  }),
);

export const OpenAIEnrollmentModelsSchema = z
  .array(CatalogModel.strict())
  .min(1)
  .max(REVIEWED_OPENAI_ENROLLMENT_MODELS.length)
  .superRefine((models, context) => {
    if (
      !models.some((model) => model.id === 'gpt-6-luna') ||
      new Set(models.map((model) => model.id)).size !== models.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Enrollment catalog requires unique models and validated Luna availability',
      });
    for (const model of models) {
      const reviewed = REVIEWED_OPENAI_ENROLLMENT_MODELS.find(
        (candidate) => candidate.id === model.id,
      );
      if (!reviewed || !isDeepStrictEqual(model, reviewed))
        context.addIssue({
          code: 'custom',
          message: 'Enrollment model differs from reviewed capabilities',
        });
    }
  });
const maxCatalogBytes = 512 * 1024;
const ModelsResponse = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(128) }).passthrough()).max(2000),
  has_more: z.literal(false).optional(),
});
async function boundedCatalog(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > maxCatalogBytes || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maxCatalogBytes) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/** Metadata GET only. The separate attended validation performs the single Luna inference check. */
export async function discoverOpenAIEnrollmentModels(
  value: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<CatalogModel[]> {
  try {
    signal.throwIfAborted();
    if (!value.trim() || value.length > 16384) throw new Error();
    const response = await request('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error();
    const catalog = ModelsResponse.parse(await boundedCatalog(response, signal));
    const available = new Set(catalog.data.map((model) => model.id));
    const models = REVIEWED_OPENAI_ENROLLMENT_MODELS.filter((model) => available.has(model.id));
    return OpenAIEnrollmentModelsSchema.parse(structuredClone(models));
  } catch {
    throw new Error('OpenAI model discovery failed');
  }
}
