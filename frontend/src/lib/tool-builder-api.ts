import { apiFetch } from './api-fetch';

export type ToolDraftStatus = 'unpublished' | 'submitted' | 'accepted' | 'rejected' | 'cancelled';
export type ToolDraftSummary = {
  id: string;
  version: number;
  name: string;
  status: ToolDraftStatus;
  sessionId: string;
  contractDigest: string;
  sourceDigest: string;
  tests: string;
};
export type ToolDraftRecord = {
  status: ToolDraftStatus;
  sessionId: string;
  review?: {
    decision: 'accepted' | 'rejected';
    feedback: string;
    contractDigest: string;
    reviewer: string;
  };
  draft: {
    id: string;
    version: number;
    name: string;
    description: string;
    contractDigest: string;
    sourceDigest: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    examples: Array<{ input: Record<string, unknown>; expected: Record<string, unknown> }>;
    permissions: { behavior: string; requiredConnections: string[] };
    compatibility: { routes: string[] };
    testProfile: string;
    files: Array<{ path: string; content: string }>;
    tests: {
      summary: string;
      evidenceKind: 'candidate-report' | 'trusted-executor';
      passed: boolean;
      complete: boolean;
    };
  };
};

export async function toolBuilderRequest<T>(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  // Keep older supported WebKit compatible without static AbortSignal helpers.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const response = await apiFetch('/api/agent-library/tool-builder' + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    controller.signal.throwIfAborted();
    if (!response.ok) throw Error(data.error ?? 'Tool draft request failed');
    return data;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
