import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ResponsesSession, type ModelSessionConfig, type ModelSession } from '@mitzo/harness';
import { ChatGptPlanAdviserAccounts } from './chatgpt-plan-adviser.js';
import { FilePlanAdviserStore } from './chatgpt-plan-adviser-store.js';
import { registerAuthSession } from './auth.js';
import type { AdviserRequest } from './terminal-adviser.js';
interface Attempt {
  id: string;
  owner: string;
  state: 'pending' | 'connected' | 'failed' | 'cancelled';
  controller: AbortController;
  listener: Server;
  timer: ReturnType<typeof setTimeout>;
  unobserve: () => void;
}
/** Human sign-in is completed in the host's system browser, so a phone never
 * receives credentials or has to provide a loopback callback to the Mac. */
export class TerminalPlanAdviserHost {
  private attempts = new Map<string, Attempt>();
  constructor(
    private options: {
      accounts: ChatGptPlanAdviserAccounts;
      openBrowser(url: string): Promise<void>;
      closeStore(): void;
    },
  ) {}
  list() {
    return this.options.accounts.list();
  }
  catalog() {
    return this.options.accounts.catalog();
  }
  async session(config: ModelSessionConfig, request: AdviserRequest): Promise<ModelSession> {
    if (config.tools?.length || config.thinking)
      throw Error('Subscription advisers support text inference only');
    const signal = config.signal ?? AbortSignal.timeout(120000);
    const grant = await this.options.accounts.ready(
      request.accountId,
      request.model,
      request.reasoningEffort,
      signal,
    );
    grant.assertCurrent();
    const model = new ResponsesSession(
      { ...config, tools: [], signal: AbortSignal.any([signal, grant.signal]) },
      {
        accountId: request.accountId,
        authentication: 'chatgpt-plan',
        textTranscript: true,
        getAccessToken: async () => grant.accessToken(),
      },
    );
    return {
      provider: model.provider,
      async *turn(messages) {
        grant.assertCurrent();
        for await (const event of model.turn(messages)) {
          grant.assertCurrent();
          yield event;
        }
        grant.assertCurrent();
      },
    };
  }
  async start(owner: string, expiresAt: number, label: string, accountId?: string) {
    if (
      expiresAt <= Date.now() ||
      [...this.attempts.values()].some((attempt) => attempt.state === 'pending')
    )
      throw Error('Adviser sign-in unavailable or busy');
    while (this.attempts.size >= 30) this.attempts.delete(this.attempts.keys().next().value!);
    const controller = new AbortController(),
      id = randomUUID();
    const listener = createServer();
    let attempt: Attempt | undefined;
    const stop = () => {
      if (!attempt) return;
      clearTimeout(attempt.timer);
      attempt.unobserve();
      listener.close();
      listener.closeAllConnections();
    };
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', () => {
          listener.off('error', reject);
          resolve();
        });
      });
      const address = listener.address();
      if (!address || typeof address === 'string') throw Error('Sign-in callback unavailable');
      const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = this.options.accounts.begin(owner, redirect, label, accountId);
      attempt = {
        id,
        owner,
        controller,
        listener,
        state: 'pending',
        unobserve: () => {},
        timer: setTimeout(
          () => {
            void this.cancel(owner, id);
          },
          Math.min(600000, expiresAt - Date.now()),
        ),
      };
      attempt.timer.unref();
      this.attempts.set(id, attempt);
      const current = attempt;
      current.unobserve = registerAuthSession({ id: owner, expiresAt }, () => {
        void this.cancel(owner, id);
      });
      listener.on('request', (req, res) => {
        // Never log incoming paths: callback URLs contain a short-lived authorization code.
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        if (
          req.method !== 'GET' ||
          !req.url ||
          req.url.length > 8192 ||
          !req.url.startsWith('/auth/callback?') ||
          current.state !== 'pending'
        ) {
          res.writeHead(404);
          res.end('Sign-in callback unavailable.');
          return;
        }
        listener.close();
        void this.options.accounts
          .complete(owner, new URL(req.url, redirect), controller.signal)
          .then(
            () => {
              if (controller.signal.aborted) return;
              current.state = 'connected';
              res.end('ChatGPT adviser connected. Return to Mitzo and refresh accounts.');
            },
            () => {
              if (!controller.signal.aborted) {
                current.state = 'failed';
                res.writeHead(400);
                res.end('ChatGPT adviser sign-in did not complete. Return to Mitzo and retry.');
              }
            },
          )
          .finally(() => {
            clearTimeout(current.timer);
            current.unobserve();
          });
      });
      controller.signal.throwIfAborted();
      await this.options.openBrowser(url);
      controller.signal.throwIfAborted();
      return { id, state: current.state };
    } catch {
      if (attempt) {
        attempt.state = 'failed';
        controller.abort();
        this.options.accounts.cancel(owner);
      }
      stop();
      listener.close();
      throw Error('ChatGPT adviser sign-in could not open on the Mac');
    }
  }
  status(owner: string, id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== owner) throw Error('Adviser sign-in unavailable');
    return { id, state: attempt.state };
  }
  async cancel(owner: string, id: string) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.owner !== owner) throw Error('Adviser sign-in unavailable');
    if (attempt.state !== 'pending') return;
    attempt.state = 'cancelled';
    attempt.controller.abort();
    this.options.accounts.cancel(owner);
    clearTimeout(attempt.timer);
    attempt.unobserve();
    attempt.listener.close();
    attempt.listener.closeAllConnections();
  }
  disconnect(id: string, signal: AbortSignal) {
    return this.options.accounts.disconnect(id, signal);
  }
  async close() {
    for (const attempt of this.attempts.values()) await this.cancel(attempt.owner, attempt.id);
    await this.options.accounts.close();
    this.options.closeStore();
  }
}
let active: TerminalPlanAdviserHost | null = null;
/** Host bootstrap capability; never supplied by request/account profile JSON. */
export function setTerminalPlanAdviserHost(host: TerminalPlanAdviserHost | null) {
  active = host;
}
export function getTerminalPlanAdviserHost() {
  return active;
}
export function createTerminalPlanAdviserHost(env: NodeJS.ProcessEnv) {
  if (env.MITZO_CHATGPT_PLAN_ADVISER_ENABLED !== '1') return null;
  if (process.platform !== 'darwin' || !env.MITZO_CHATGPT_PLAN_ADVISER_DIR)
    throw Error('Reviewed Mac adviser credential storage is required');
  const store = new FilePlanAdviserStore(env.MITZO_CHATGPT_PLAN_ADVISER_DIR);
  try {
    return new TerminalPlanAdviserHost({
      accounts: new ChatGptPlanAdviserAccounts({ store }),
      closeStore: () => store.close(),
      openBrowser: (url) =>
        new Promise<void>((resolve, reject) => {
          const parsed = new URL(url);
          if (
            parsed.origin !== 'https://auth.openai.com' ||
            parsed.pathname !== '/api/accounts/authorize'
          ) {
            reject(Error('Sign-in origin changed'));
            return;
          }
          execFile(
            '/usr/bin/open',
            [url],
            { env: { PATH: '/usr/bin:/bin' }, timeout: 5000 },
            (error) => (error ? reject(Error('System browser unavailable')) : resolve()),
          );
        }),
    });
  } catch {
    store.close();
    throw Error('ChatGPT adviser host could not initialize');
  }
}
