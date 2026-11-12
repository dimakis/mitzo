import { Router } from 'express';
import {
  NativeSubagentControlSchema,
  NativeSubagentInspectionSchema,
  type NativeSubagentSnapshot,
  type NativeSubagentControl,
  type NativeSubagentControlStatus,
} from '@mitzo/protocol';
import { registerAuthSession, type AuthSession } from './auth.js';
import type { CodexSubagents } from './codex-subagents.js';

interface Owners {
  authorize(id: string, authorization?: AuthSession): void;
  owner(id: string): Pick<CodexSubagents, 'list' | 'control' | 'subscribe' | 'inspect'> | undefined;
  retained(id: string): NativeSubagentSnapshot[];
  retainedControl?(
    id: string,
    input: NativeSubagentControl,
  ): NativeSubagentControlStatus | undefined;
}
/** Mounted behind application authentication. Public child transcripts remain
 * within the original conversation/operator boundary, including SSE delivery. */
export function createCodexSubagentRouter(deps: Owners) {
  const router = Router();
  router.use('/:id/codex-subagents', (req, res, next) => {
    try {
      deps.authorize(req.params.id, res.locals.authSession as AuthSession | undefined);
      next();
    } catch {
      res
        .status(403)
        .json({ error: 'Use the original sign-in to inspect or direct these subagents.' });
    }
  });
  router.get('/:id/codex-subagents', (req, res) => {
    const owner = deps.owner(req.params.id);
    res.json({ agents: owner?.list() ?? deps.retained(req.params.id), available: !!owner });
  });
  router.post('/:id/codex-subagents/inspect', async (req, res) => {
    const input = NativeSubagentInspectionSchema.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'An exact existing child identity is required.' });
      return;
    }
    const owner = deps.owner(req.params.id);
    if (!owner) {
      res
        .status(409)
        .json({ error: 'The original runtime is unavailable. Saved output is retained.' });
      return;
    }
    const authorize = () => {
      deps.authorize(req.params.id, res.locals.authSession as AuthSession | undefined);
      if (deps.owner(req.params.id) !== owner) throw Error('Original inspection owner changed');
    };
    try {
      const agent = await owner.inspect(input.data.threadId, authorize);
      authorize();
      if (!agent) {
        res.status(404).json({ error: 'This child is unavailable to the original runtime.' });
        return;
      }
      res.json({ agent });
    } catch {
      res.status(409).json({
        error: 'Inspection is unavailable under the original authority. Saved output is retained.',
      });
    }
  });
  router.get('/:id/codex-subagents/events', (req, res) => {
    const owner = deps.owner(req.params.id);
    const auth = res.locals.authSession as AuthSession | undefined;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let unsubscribe = () => {};
    let releaseAuth = () => {};
    let timer: ReturnType<typeof setInterval> | undefined = undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      unsubscribe();
      releaseAuth();
      res.end();
    };
    const write = (value: Record<string, unknown>) => {
      if (closed) return;
      deps.authorize(req.params.id, auth);
      if (res.writableLength > 1024 * 1024) {
        close();
        return;
      }
      res.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    const send = (child?: NativeSubagentSnapshot) => {
      if (closed) return;
      try {
        deps.authorize(req.params.id, auth);
        const current = deps.owner(req.params.id);
        const available = !!owner && current === owner;
        write(available && child ? { type: 'agent', agent: child } : { type: 'status', available });
        if (!available) close();
      } catch {
        close();
      }
    };
    res.on('close', close);
    if (auth) {
      try {
        releaseAuth = registerAuthSession(auth, close);
      } catch {
        close();
        return;
      }
    }
    if (closed) {
      releaseAuth();
      return;
    }
    try {
      const agents = owner?.list() ?? deps.retained(req.params.id);
      write({ type: 'reset', available: !!owner });
      for (const agent of agents) write({ type: 'agent', agent });
      if (!owner) {
        close();
        return;
      }
    } catch {
      close();
      return;
    }
    if (owner) unsubscribe = owner.subscribe(send);
    timer = setInterval(() => send(), 15000);
    timer.unref();
    send();
  });
  router.post('/:id/codex-subagents/control', async (req, res) => {
    const parsed = NativeSubagentControlSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'A valid child identity and message or stop request are required.' });
      return;
    }
    const input = parsed.data;
    try {
      const receipt = deps.retainedControl?.(req.params.id, input);
      if (receipt) {
        res.json({ requestId: input.requestId, status: receipt });
        return;
      }
    } catch {
      res.status(409).json({ error: 'Request identity differs from its saved receipt.' });
      return;
    }
    const owner = deps.owner(req.params.id);
    if (!owner) {
      res.json({ requestId: input.requestId, status: 'rejected' });
      return;
    }
    const authorize = () => {
      deps.authorize(req.params.id, res.locals.authSession as AuthSession | undefined);
      if (deps.owner(req.params.id) !== owner) throw Error('Original child owner changed');
    };
    try {
      res.json({ requestId: input.requestId, status: await owner.control(input, authorize) });
    } catch {
      res.status(409).json({
        error: 'Cannot deliver this request. Check its existing identity before sending again.',
      });
    }
  });
  return router;
}
