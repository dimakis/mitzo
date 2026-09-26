import { randomUUID } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import {
  DeviceLoginCleanupError,
  DEVICE_LOGIN_WINDOW_MS,
  type DeviceLogin,
} from './symposium-device-login.js';

interface LoginHost {
  beginDeviceLogin?: () => Promise<DeviceLogin>;
  beginLogin?: () => Promise<{
    authorizationUrl: string;
    completed: Promise<unknown>;
    cancel?: () => void | Promise<void>;
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
export function createSubscriptionLoginController(
  getHost: () => LoginHost | undefined,
  getOwner: (req: Request, res: Response) => string | undefined = () => 'user',
): {
  start: RequestHandler;
  status: RequestHandler;
  cancel: RequestHandler;
} {
  let attempt:
    | {
        attemptId: string;
        state: 'pending' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'unknown';
        method?: 'device-code';
        verificationUrl?: string;
        userCode?: string;
        expiresAt?: number;
        account?: { label: string; email: string; planType: string };
      }
    | undefined;
  let owner: string | undefined;
  let cancelLogin: (() => void | Promise<void>) | undefined;
  let cancelling = false;
  let quarantined = false;
  let allocated: Promise<void> = Promise.resolve();
  let allocatedDone = () => {};
  let receiptDeadline = 0;
  const publicReceipt = () => {
    if (!attempt) return { state: 'idle' };
    if (attempt.state !== 'pending' && Date.now() >= receiptDeadline)
      return { state: 'unknown', ...(quarantined ? { retryBlocked: true } : {}) };
    const { verificationUrl, userCode, ...receipt } = attempt;
    return attempt.state === 'pending'
      ? { ...receipt, ...(verificationUrl ? { verificationUrl, userCode } : {}) }
      : { ...receipt, ...(quarantined ? { retryBlocked: true } : {}) };
  };
  const expire = async () => {
    if (attempt?.state !== 'pending' || !attempt.expiresAt || Date.now() < attempt.expiresAt)
      return;
    attempt.state = 'expired';
    cancelling = true;
    try {
      await allocated;
      if (!cancelLogin) throw new Error('Cancellation unavailable');
      await cancelLogin();
    } catch {
      attempt.state = 'unknown';
      quarantined = true;
    } finally {
      cancelling = false;
    }
  };

  const status: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      (owner && owner !== getOwner(req, res)) ||
      (req.query.attemptId && req.query.attemptId !== attempt?.attemptId)
    ) {
      res.json({ state: 'unknown' });
      return;
    }
    await expire();
    res.json(publicReceipt());
  };
  const start: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticatedOwner = getOwner(req, res);
    if (!authenticatedOwner) {
      res.status(403).json({ error: 'Interactive operator authentication is required.' });
      return;
    }
    const device = req.body?.method === 'device-code';
    const transport: unknown = req.body?.callbackTransport;
    if (req.body?.method !== undefined && !device) {
      res.status(400).json({ error: 'Unsupported login method.' });
      return;
    }
    if (!device && transport !== 'host-local' && transport !== 'ssh-forwarded') {
      res.status(409).json({
        error:
          'Choose and prepare a callback transport before starting personal subscription login.',
        code: 'callback_transport_required',
        requiredBody: { callbackTransport: 'host-local | ssh-forwarded' },
        ...callbackWorkflow,
      });
      return;
    }
    await expire();
    if (quarantined || cancelling || attempt?.state === 'pending') {
      res.status(409).json({
        error: quarantined
          ? 'Device login cleanup is unconfirmed. Host recovery is required before retry.'
          : 'A personal subscription login is already pending.',
        ...(quarantined ? { retryBlocked: true } : {}),
      });
      return;
    }
    const current = {
      attemptId: randomUUID(),
      state: 'pending' as const,
      ...(device
        ? { method: 'device-code' as const, expiresAt: Date.now() + DEVICE_LOGIN_WINDOW_MS }
        : {}),
    };
    receiptDeadline = Date.now() + 2 * DEVICE_LOGIN_WINDOW_MS;
    allocated = new Promise<void>((resolve) => {
      allocatedDone = resolve;
    });
    attempt = current;
    owner = authenticatedOwner;
    cancelLogin = undefined;
    try {
      const host = getHost();
      if (device ? !host?.beginDeviceLogin : !host?.beginLogin) throw new Error('Unavailable');
      const login = device ? await host!.beginDeviceLogin!() : await host!.beginLogin!();
      cancelLogin = login.cancel;
      allocatedDone();
      void login.completed.catch(() => undefined);
      if (device && attempt?.state === 'pending') {
        const selected = login as DeviceLogin;
        if (
          selected.verificationUrl !== 'https://auth.openai.com/codex/device' ||
          !/^[A-Za-z0-9-]{4,32}$/.test(selected.userCode) ||
          !Number.isFinite(selected.expiresAt) ||
          selected.expiresAt <= Date.now()
        ) {
          await login.cancel?.();
          throw new Error('Unsupported device login');
        }
        attempt = {
          ...current,
          method: 'device-code',
          verificationUrl: selected.verificationUrl,
          userCode: selected.userCode,
          expiresAt: Math.min(current.expiresAt!, selected.expiresAt),
        };
      }
      // Credentials and token-bearing failures never enter responses or logs.
      void login.completed.then(
        (result) => {
          const verified = result as
            | { email?: unknown; planType?: unknown; binding?: { accountLabel?: unknown } }
            | undefined;
          const account =
            verified &&
            typeof verified.email === 'string' &&
            verified.email.length <= 254 &&
            typeof verified.planType === 'string' &&
            ['free', 'plus', 'pro'].includes(verified.planType.toLowerCase()) &&
            typeof verified.binding?.accountLabel === 'string' &&
            verified.binding.accountLabel.length <= 200
              ? {
                  email: verified.email,
                  planType: verified.planType,
                  label: verified.binding.accountLabel,
                }
              : undefined;
          if (attempt?.attemptId === current.attemptId && attempt.state === 'pending')
            attempt = {
              ...attempt,
              ...(account && (!attempt.expiresAt || Date.now() < attempt.expiresAt)
                ? { account }
                : {}),
              state: attempt.expiresAt && Date.now() >= attempt.expiresAt ? 'unknown' : 'completed',
            };
        },
        (error) => {
          if (error instanceof DeviceLoginCleanupError) quarantined = true;
          if (attempt?.attemptId === current.attemptId && attempt.state === 'pending')
            attempt = {
              ...attempt,
              state: quarantined
                ? 'unknown'
                : attempt.expiresAt && Date.now() >= attempt.expiresAt
                  ? 'expired'
                  : 'failed',
            };
        },
      );
      if (device) {
        res.json(publicReceipt());
        return;
      }
      res.json({
        attemptId: current.attemptId,
        authorizationUrl: 'authorizationUrl' in login ? login.authorizationUrl : undefined,
        callbackTransport: transport,
        ...callbackWorkflow,
      });
    } catch (error) {
      allocatedDone();
      if (error instanceof DeviceLoginCleanupError) quarantined = true;
      if (attempt?.attemptId === current.attemptId && attempt.state === 'pending')
        attempt = { ...attempt, state: quarantined ? 'unknown' : 'failed' };
      res.status(503).json({
        error: device
          ? 'Device login is unavailable or did not complete. Enable device code login in ChatGPT Security settings and retry explicitly.'
          : 'Personal subscription login is unavailable or already pending. Check the host and ensure callback port 1455 is free, then retry.',
      });
    }
  };
  const cancel: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!attempt || owner !== getOwner(req, res) || req.body?.attemptId !== attempt.attemptId) {
      res.json({ state: 'unknown' });
      return;
    }
    if (attempt.state !== 'pending') {
      res.json(publicReceipt());
      return;
    }
    attempt.state = 'cancelled';
    cancelling = true;
    try {
      await allocated;
      if (!cancelLogin) throw new Error('Cancellation unavailable');
      await cancelLogin();
    } catch {
      attempt.state = 'unknown';
      quarantined = true;
    } finally {
      cancelling = false;
    }
    res.json(publicReceipt());
  };
  return { start, status, cancel };
}
