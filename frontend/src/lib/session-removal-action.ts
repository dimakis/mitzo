import { apiFetch } from './api-fetch';

/** One bounded mutation, including body consumption. On timeout only read the
 * original removal state; never infer failure or replay the operation. */
export async function sessionRemovalAction<T>(
  path: string,
  body: object,
  owner?: AbortSignal,
  method = 'POST',
): Promise<T> {
  const controller = new AbortController();
  let timeout!: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(Error('Removal is unconfirmed. Review the original operation.'));
    };
    timeout = setTimeout(abort, 125_000);
    owner?.addEventListener('abort', abort, { once: true });
    if (owner?.aborted) abort();
  });
  try {
    if (controller.signal.aborted) return await interruption;
    return await Promise.race([
      (async () => {
        const response = await apiFetch(path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok)
          throw Error(
            typeof result?.error === 'string'
              ? result.error
              : 'Removal could not be confirmed. Review again.',
          );
        return result as T;
      })(),
      interruption,
    ]);
  } finally {
    clearTimeout(timeout);
    owner?.removeEventListener('abort', abort);
  }
}
