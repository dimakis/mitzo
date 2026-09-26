import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

interface LoginHost {
  beginLogin?: () => Promise<{
    authorizationUrl: string;
    completed: Promise<unknown>;
  }>;
}

// The provider's registered redirect belongs to the browser machine, not the
// HTTP API client. Neither socket addresses nor proxy headers prove reachability.
const callbackWorkflow = {
  callbackUrl: 'http://localhost:1455/auth/callback',
  transports: {
    'host-local': 'Open the authorization URL in a browser on the Mitzo server itself.',
    'ssh-forwarded':
      'Before requesting login, run ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 USER@MITZO_HOST on the computer running the browser. Keep it running until login completes. Replace USER@MITZO_HOST with your SSH destination.',
  },
  ipv4Requirement:
    'The listener and SSH forward bind IPv4 127.0.0.1 only. The browser must resolve localhost to or fall back to 127.0.0.1; IPv6-only localhost (::1) will fail. Keep the registered callback URL unchanged.',
  limitation:
    'A phone or another computer without this local SSH forward cannot complete this login. Use a browser on the Mitzo server or an SSH-capable computer. Forwarding the web UI alone is insufficient.',
};

/** Require an explicit browser/callback workflow before allocating a login. */
export function createSubscriptionLoginHandler(
  getHost: () => LoginHost | undefined,
): RequestHandler {
  return createSubscriptionLoginController(getHost).start;
}

/** Ephemeral operator receipts; restart never implies a successful login. */
export function createSubscriptionLoginController(getHost: () => LoginHost | undefined): {
  start: RequestHandler;
  status: RequestHandler;
} {
  let attempt: { attemptId: string; state: 'pending' | 'completed' | 'failed' } | undefined;
  const status: RequestHandler = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.attemptId && req.query.attemptId !== attempt?.attemptId) {
      res.json({ state: 'unknown' });
      return;
    }
    res.json(attempt ?? { state: 'idle' });
  };
  const start: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const transport: unknown = req.body?.callbackTransport;
    if (transport !== 'host-local' && transport !== 'ssh-forwarded') {
      res.status(409).json({
        error:
          'Choose and prepare a callback transport before starting personal subscription login.',
        code: 'callback_transport_required',
        requiredBody: { callbackTransport: 'host-local | ssh-forwarded' },
        ...callbackWorkflow,
      });
      return;
    }
    if (attempt?.state === 'pending') {
      res.status(409).json({ error: 'A personal subscription login is already pending.' });
      return;
    }
    const current = { attemptId: randomUUID(), state: 'pending' as const };
    attempt = current;
    try {
      const host = getHost();
      if (!host?.beginLogin) throw new Error('Unavailable');
      const login = await host.beginLogin();
      // Credentials and token-bearing failures never enter responses or logs.
      void login.completed.then(
        () => {
          if (attempt?.attemptId === current.attemptId)
            attempt = { ...current, state: 'completed' };
        },
        () => {
          if (attempt?.attemptId === current.attemptId) attempt = { ...current, state: 'failed' };
        },
      );
      res.json({
        attemptId: current.attemptId,
        authorizationUrl: login.authorizationUrl,
        callbackTransport: transport,
        ...callbackWorkflow,
      });
    } catch {
      if (attempt?.attemptId === current.attemptId) attempt = { ...current, state: 'failed' };
      res.status(503).json({
        error:
          'Personal subscription login is unavailable or already pending. Check the host and ensure callback port 1455 is free, then retry.',
      });
    }
  };
  return { start, status };
}
