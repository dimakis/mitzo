import { z } from 'zod';
import type { CodexLifecycleTransport } from './codex-app-server-client.js';
import { codexRuntimeOverrides } from './codex-runtime-policy.js';
import { SEARCH_INSTRUCTIONS } from './web-search-adapters.js';
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
  workspaceId?: string;
}

/** A separate tool-less thread on the same verified route. Never changes the parent's consent. */
export async function searchCodex(
  query: string,
  callerSignal: AbortSignal,
  options: Options,
): Promise<string> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(90_000)]);
  let threadId: string | undefined;
  const turns = new Map<string, { searched: boolean; text: string[] }>();
  let finish!: (value: { id: string; status: string }) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<{ id: string; status: string }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  const client = options.createClient({
    onRequest: async () => {
      throw new Error('Search request has no executable tools');
    },
    onClose: () => fail(new Error('Search transport closed')),
    onNotification: (method, params) => {
      if (!threadId || params.threadId !== threadId) return;
      if (method === 'turn/completed') {
        const turn = z.object({ id: z.string(), status: z.string() }).safeParse(params.turn);
        if (turn.success) finish(turn.data);
      }
      if (method !== 'item/completed' || typeof params.turnId !== 'string') return;
      const item = z
        .object({ type: z.string(), text: z.string().optional() })
        .safeParse(params.item);
      if (!item.success) return;
      const turn = turns.get(params.turnId) ?? { searched: false, text: [] };
      if (item.data.type === 'webSearch') turn.searched = true;
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
    await step(options.verify(client));
    signal.throwIfAborted();
    const configuration = z
      .object({ config: z.unknown() })
      .parse(await step(client.request('config/read', { cwd: options.cwd, includeLayers: false })));
    const config = {
      ...options.runtimeConfig,
      ...codexRuntimeOverrides(configuration.config, options.workspaceId),
      web_search: 'live',
      'features.code_mode_host': false,
    };
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
            approvalPolicy: 'never',
            sandbox: 'read-only',
            developerInstructions: SEARCH_INSTRUCTIONS,
          }),
        ),
      );
    if (thread.model !== options.model || thread.modelProvider !== options.modelProvider)
      throw new Error('Search route changed');
    threadId = thread.thread.id;
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
    const terminal = await completed;
    const turn = turns.get(start.turn.id);
    if (
      terminal.id !== start.turn.id ||
      terminal.status !== 'completed' ||
      !turn?.searched ||
      !turn.text.length
    )
      throw new Error('Search did not complete with a receipt');
    signal.throwIfAborted();
    const answer = turn.text.join('\n');
    if (!/https?:\/\//.test(answer)) throw new Error('Search did not provide source URLs');
    return answer;
  } finally {
    signal.removeEventListener('abort', onAbort);
    client.close();
  }
}
