import { expect, it, vi } from 'vitest';
import {
  discoverOpenAIEnrollmentModels,
  OpenAIEnrollmentModelsSchema,
  REVIEWED_OPENAI_ENROLLMENT_MODELS,
} from '../openai-enrollment-models.js';
const signal = () => AbortSignal.timeout(5000);
it('discovers account model availability through one bounded official metadata GET', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-6-luna' },
          { id: 'gpt-6.1-sol' },
          { id: 'gpt-5.6-terra' },
          { id: 'gpt-5.4-nano' },
          { id: 'unreviewed-api-model' },
        ],
      }),
    ),
  );
  const models = await discoverOpenAIEnrollmentModels('SYNTHETIC_KEY', signal(), request);
  expect(models.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra']);
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    'https://api.openai.com/v1/models',
    expect.objectContaining({
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer SYNTHETIC_KEY' },
    }),
  );
  expect(models).toEqual(
    REVIEWED_OPENAI_ENROLLMENT_MODELS.filter((model) =>
      models.some((selected) => selected.id === model.id),
    ),
  );
});
it('requires the successfully validated Luna model and strips upstream model metadata', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }] })))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ id: 'gpt-6-luna', label: 'injected', reasoningEfforts: ['unknown'] }],
        }),
      ),
    );
  await expect(discoverOpenAIEnrollmentModels('SYNTHETIC_KEY', signal(), request)).rejects.toThrow(
    'OpenAI model discovery failed',
  );
  expect((await discoverOpenAIEnrollmentModels('SYNTHETIC_KEY', signal(), request))[0]).toEqual(
    REVIEWED_OPENAI_ENROLLMENT_MODELS.find((model) => model.id === 'gpt-6-luna'),
  );
});
it('fails closed on upstream errors, malformed catalogs, truncated pages, and oversized bodies', async () => {
  for (const response of [
    new Response('private upstream text', { status: 401 }),
    new Response('not JSON'),
    new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }], has_more: true })),
    new Response('x'.repeat(524289)),
  ]) {
    await expect(
      discoverOpenAIEnrollmentModels(
        'SYNTHETIC_KEY',
        signal(),
        vi.fn<typeof fetch>().mockResolvedValue(response),
      ),
    ).rejects.toThrow(/^OpenAI model discovery failed$/);
  }
});
it('validates immutable persisted model IDs, labels, reasoning levels, and unique Luna membership', () => {
  const luna = REVIEWED_OPENAI_ENROLLMENT_MODELS.find((model) => model.id === 'gpt-6-luna')!;
  expect(OpenAIEnrollmentModelsSchema.parse([luna])).toEqual([luna]);
  for (const catalog of [
    [{ ...luna, reasoningEfforts: ['ultra'] }],
    [{ ...luna, label: 'unreviewed' }],
    [{ ...luna, id: 'gpt-5.4-nano' }],
    [luna, luna],
    [],
  ])
    expect(OpenAIEnrollmentModelsSchema.safeParse(catalog).success).toBe(false);
});
