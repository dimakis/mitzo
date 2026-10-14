import { apiFetch } from './api-fetch';

/** Opt-in metadata GET: the deadline includes JSON body consumption. No replay. */
export async function readApiJson<T>(path: string, owner?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timeout!: ReturnType<typeof setTimeout>;
  let abortOwner!: () => void;
  const interruption = new Promise<never>((_resolve, reject) => {
    abortOwner = () => {
      reject(new DOMException('Read cancelled', 'AbortError'));
      controller.abort();
    };
    timeout = setTimeout(() => {
      reject(new Error('Read request timed out'));
      controller.abort();
    }, 10_000);
    owner?.addEventListener('abort', abortOwner, { once: true });
    if (owner?.aborted) abortOwner();
  });
  try {
    if (controller.signal.aborted) return await interruption;
    const request = (async () => {
      const response = await apiFetch(path, { signal: controller.signal });
      if (!response.ok) throw new Error(`Read request failed (${response.status})`);
      return response.json() as Promise<T>;
    })();
    return await Promise.race([request, interruption]);
  } finally {
    clearTimeout(timeout);
    owner?.removeEventListener('abort', abortOwner);
  }
}
