import { assertNativeCodexContextAdmission } from './native-codex-context-admission.js';
import { z } from 'zod';
import {
  CodexRequestError,
  CodexTransportError,
  type CodexLifecycleTransport,
} from './codex-app-server-client.js';
import { codexRuntimeOverrides, codexSearchToolConfig } from './codex-runtime-policy.js';
import { SEARCH_INSTRUCTIONS } from './web-search-adapters.js';
import { WebAccessError } from './request-web-access.js';
import { webSearchFailure } from './web-search-errors.js';

const searchFailure = (detail: string) => webSearchFailure('native Codex', detail);
// Inspect only protocol discriminants, never return model/provider messages.
function turnFailure(error: unknown): string {
  const info = z.object({ codexErrorInfo: z.unknown() }).safeParse(error);
  const code = info.success ? info.data.codexErrorInfo : undefined;
  const kind =
    typeof code === 'string'
      ? code
      : code && typeof code === 'object'
        ? Object.keys(code)[0]
        : undefined;
  switch (kind) {
    case 'unauthorized':
      return 'authentication failed';
    case 'usageLimitExceeded':
      return 'rate or quota limit was reached';
    case 'contextWindowExceeded':
      return 'context limit was reached';
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
      return 'provider connection failed';
    case 'serverOverloaded':
      return 'service was unavailable';
    default:
      return 'turn did not complete';
  }
}
type Terminal = { id: string; status: string; failure: string };
interface Rpc {
  initialize(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
interface Options {
  createClient(callbacks: CodexLifecycleTransport): Rpc;
  verify(client: Rpc): Promise<unknown>;
  model: string;
  modelProvider: string;
  cwd: string;
  runtimeConfig?: Record<string, unknown>;
  /** Captured parent document preference for the separate native search thread. */
  readonly disableProjectDocuments?: boolean;
  /** Trusted parent context source; document preferences do not establish origin. */
  readonly agentContextSource?: string;
  workspaceId?: string;
}

/** A separate tool-less thread on the same verified route. Never changes the parent's consent. */
export async function searchCodex(
  query: string,
  callerSignal: AbortSignal,
  options: Options,
): Promise<string> {
  assertNativeCodexContextAdmission({ source: options.agentContextSource });
  const signal = callerSignal;
  let phase = 'transport initialization failed';
  let threadId: string | undefined;
  const turns = new Map<string, { searched: boolean; text: string[] }>();
  let finish!: (value: Terminal) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<Terminal>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  const client = options.createClient({
    onRequest: async () => {
      throw new Error('Search request has no executable tools');
    },
    onClose: () => fail(searchFailure('transport closed before completion')),
    onNotification: (method, params) => {
      if (!threadId || params.threadId !== threadId) return;
      if (method === 'turn/completed') {
        const turn = z
          .object({ id: z.string(), status: z.string(), error: z.unknown().optional() })
          .safeParse(params.turn);
        if (turn.success) finish({ ...turn.data, failure: turnFailure(turn.data.error) });
      }
      if (method !== 'item/completed' || typeof params.turnId !== 'string') return;
      const item = z
        .object({
          type: z.string(),
          id: z.string().optional(),
          query: z.string().optional(),
          text: z.string().optional(),
          status: z.string().optional(),
          error: z.unknown().optional(),
        })
        .safeParse(params.item);
      if (!item.success) return;
      const turn = turns.get(params.turnId) ?? { searched: false, text: [] };
      if (
        item.data.type === 'webSearch' &&
        !!item.data.id &&
        !!item.data.query?.trim() &&
        // The pinned protocol has no status field: item/completed is the receipt.
        (item.data.status === undefined || item.data.status === 'completed') &&
        item.data.error == null
      )
        turn.searched = true;
      if (item.data.type === 'agentMessage' && item.data.text) turn.text.push(item.data.text);
      turns.set(params.turnId, turn);
    },
  });
  const onAbort = () => {
    fail(new Error('Search interrupted'));
    client.close();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const step = <T>(work: Promise<T>) =>
    Promise.race([work, completed.then(() => new Promise<T>(() => {}))]);
  try {
    signal.throwIfAborted();
    await step(client.initialize());
    phase = 'account verification failed';
    await step(options.verify(client));
    signal.throwIfAborted();
    phase = 'runtime configuration could not be read';
    const configuration = z
      .object({ config: z.unknown() })
      .parse(await step(client.request('config/read', { cwd: options.cwd, includeLayers: false })));
    const config = {
      // Provider routing survives, but runtime-injected MCP definitions cannot enter
      // a thread approved only for search. Inherited servers are disabled below.
      ...Object.fromEntries(
        Object.entries(options.runtimeConfig ?? {}).filter(
          ([key]) => key !== 'mcp_servers' && !key.startsWith('mcp_servers.'),
        ),
      ),
      ...codexRuntimeOverrides(configuration.config, options.workspaceId),
      web_search: 'live',
      ...codexSearchToolConfig(options.modelProvider),
      ...(options.disableProjectDocuments ? { project_doc_max_bytes: 0 } : {}),
    };
    phase = 'thread could not be started';
    const thread = z
      .object({
        thread: z.object({ id: z.string().min(1) }),
        model: z.string(),
        modelProvider: z.string(),
      })
      .parse(
        await step(
          client.request('thread/start', {
            model: options.model,
            modelProvider: options.modelProvider,
            cwd: options.cwd,
            config,
            dynamicTools: [],
            allowProviderModelFallback: false,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            developerInstructions: SEARCH_INSTRUCTIONS,
          }),
        ),
      );
    if (thread.model !== options.model || thread.modelProvider !== options.modelProvider)
      throw searchFailure('account or model route changed');
    threadId = thread.thread.id;
    phase = 'turn could not be started';
    const start = z.object({ turn: z.object({ id: z.string() }) }).parse(
      await step(
        client.request('turn/start', {
          threadId,
          model: options.model,
          input: [{ type: 'text', text: query }],
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
        }),
      ),
    );
    phase = 'turn did not complete';
    const terminal = await completed;
    const turn = turns.get(start.turn.id);
    if (terminal.id !== start.turn.id) throw searchFailure('turn identity changed');
    if (terminal.status !== 'completed') throw searchFailure(terminal.failure);
    if (!turn?.searched)
      throw searchFailure(
        'returned no completed search receipt; the selected runtime did not execute a usable search. Do not repeat the same request blindly. Check runtime search capability; an approved website fetch is a separate recovery option',
      );
    if (!turn.text.length) throw searchFailure('returned no answer');
    signal.throwIfAborted();
    const answer = turn.text.join('\n');
    if (!/https?:\/\//.test(answer)) throw searchFailure('returned no source URLs');
    return answer;
  } catch (error) {
    if (signal.aborted) throw searchFailure('was interrupted');
    if (error instanceof WebAccessError) throw error;
    if (error instanceof CodexRequestError) {
      const reasons: Partial<Record<CodexRequestError['category'], string>> = {
        authentication: 'authentication failed',
        rate_limit: 'rate or quota limit was reached',
        provider_transport: 'provider connection failed',
        invalid_request: 'request was rejected by the runtime',
        context_limit: 'context limit was reached',
      };
      const detail = reasons[error.category];
      if (detail) throw searchFailure(detail);
    }
    if (error instanceof CodexTransportError)
      throw searchFailure(
        error.category === 'timeout' ? 'runtime request timed out' : 'runtime transport failed',
      );
    // Raw RPC/provider errors can include credentials or private account data.
    throw searchFailure(phase);
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
  }
}
