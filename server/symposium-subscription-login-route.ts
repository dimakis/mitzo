import type { ConnectionSelection, PersonalConnection } from './symposium-personal-connections.js';
import { randomUUID } from 'node:crypto';
import type { Request, Response, RequestHandler } from 'express';
import {
  DeviceLoginCleanupError,
  DEVICE_LOGIN_WINDOW_MS,
  type DeviceLogin,
} from './symposium-device-login.js';

interface LoginHost {
  personalConnections?: { list(): PersonalConnection[] };
  beginDeviceLogin?: (selection?: ConnectionSelection) => Promise<DeviceLogin>;
  beginLogin?: (selection?: ConnectionSelection) => Promise<{
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
        connectionId?: string;
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
  let cleanupPending: Promise<void> | undefined;
  let allocationFailedCleanly = false;
  let quarantined = false;
  let allocated: Promise<void> = Promise.resolve();
  let allocatedDone = () => {};
  let receiptDeadline = 0;
  const publicReceipt = () => {
    if (!attempt) return { state: 'idle' };
    if (attempt.state !== 'pending' && Date.now() >= receiptDeadline)
      return { state: 'unknown', ...(quarantined ? { retryBlocked: true } : {}) };
    const { verificationUrl, userCode, ...receipt } = attempt;
    return attempt.state === 'pending' && !cancelling
      ? { ...receipt, ...(verificationUrl ? { verificationUrl, userCode } : {}) }
      : { ...receipt, ...(quarantined ? { retryBlocked: true } : {}) };
  };
  const retained = new Map<
    string,
    { owner: string; deadline: number; receipt: ReturnType<typeof publicReceipt> }
  >();
  const pruneReceipts = () => {
    for (const [id, saved] of retained) if (Date.now() >= saved.deadline) retained.delete(id);
  };
  const retainedReceipt = (
    authenticatedOwner: string | undefined,
    attemptId: unknown,
    connectionId?: unknown,
  ) => {
    pruneReceipts();
    if (!authenticatedOwner) return { state: 'unknown' };
    const entries = [...retained.entries()].reverse();
    return (
      entries.find(
        ([id, saved]) =>
          saved.owner === authenticatedOwner &&
          (!attemptId || id === attemptId) &&
          (!connectionId ||
            ('connectionId' in saved.receipt && saved.receipt.connectionId === connectionId)),
      )?.[1].receipt ?? { state: 'unknown' }
    );
  };
  const retainTerminal = () => {
    pruneReceipts();
    if (!attempt || !owner || attempt.state === 'pending' || Date.now() >= receiptDeadline)
      return true;
    // Never evict another owner's still-valid recovery receipt to admit a new login.
    if (retained.size >= 128 && !retained.has(attempt.attemptId)) return false;
    retained.set(attempt.attemptId, { owner, deadline: receiptDeadline, receipt: publicReceipt() });
    return true;
  };
  const cleanupAttempt = (terminal: 'cancelled' | 'expired'): Promise<void> => {
    if (cleanupPending) return cleanupPending;
    const current = attempt;
    if (!current || current.state !== 'pending') return Promise.resolve();
    cancelling = true;
    cleanupPending = (async () => {
      try {
        await allocated;
        if (cancelLogin) await cancelLogin();
        else if (!allocationFailedCleanly) throw new Error('Cancellation unavailable');
        current.state = quarantined ? 'unknown' : terminal;
      } catch {
        current.state = 'unknown';
        quarantined = true;
      } finally {
        cancelling = false;
        cleanupPending = undefined;
      }
    })();
    return cleanupPending;
  };
  const expire = async () => {
    if (attempt?.state !== 'pending' || !attempt.expiresAt || Date.now() < attempt.expiresAt)
      return;
    await cleanupAttempt('expired');
  };

  const status: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticatedOwner = getOwner(req, res);
    const matchesCurrent = () =>
      (!owner || owner === authenticatedOwner) &&
      (!req.query.attemptId || req.query.attemptId === attempt?.attemptId) &&
      (!req.query.connectionId || req.query.connectionId === attempt?.connectionId);
    if (!matchesCurrent()) {
      res.json(retainedReceipt(authenticatedOwner, req.query.attemptId, req.query.connectionId));
      return;
    }
    await expire();
    res.json(
      matchesCurrent()
        ? publicReceipt()
        : retainedReceipt(authenticatedOwner, req.query.attemptId, req.query.connectionId),
    );
  };
  const start: RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const authenticatedOwner = getOwner(req, res);
    if (!authenticatedOwner) {
      res.status(403).json({ error: 'Interactive operator authentication is required.' });
      return;
    }
    const host = getHost();
    const connectionId: unknown = req.body?.connectionId;
    const expectedRevision: unknown = req.body?.expectedRevision;
    if (
      (connectionId !== undefined ||
        expectedRevision !== undefined ||
        host?.personalConnections !== undefined) &&
      (typeof connectionId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(connectionId) ||
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 1)
    ) {
      res.status(400).json({ error: 'A current connection revision is required.' });
      return;
    }
    const selection =
      typeof connectionId === 'string'
        ? { connectionId, expectedRevision: expectedRevision as number }
        : undefined;
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
    const catalog = host?.personalConnections;
    if (selection && catalog) {
      const row = catalog.list().find((row) => row.id === selection.connectionId);
      if (
        !row ||
        row.revision !== selection.expectedRevision ||
        ['connecting', 'disconnecting', 'recovery_required'].includes(row.state)
      ) {
        res.status(409).json({
          error: 'Connection changed or requires cleanup. Refresh its status before retry.',
          ...(row?.state === 'recovery_required' ? { retryBlocked: true } : {}),
        });
        return;
      }
    }
    if (!retainTerminal()) {
      res.status(409).json({
        error: 'Login receipt capacity is full. Retry after the recovery window expires.',
      });
      return;
    }
    const current = {
      attemptId: randomUUID(),
      state: 'pending' as const,
      ...(selection ? { connectionId: selection.connectionId } : {}),
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
    allocationFailedCleanly = false;
    try {
      if (device ? !host?.beginDeviceLogin : !host?.beginLogin) throw new Error('Unavailable');
      const login = device
        ? await host!.beginDeviceLogin!(selection)
        : await host!.beginLogin!(selection);
      cancelLogin = login.cancel;
      allocatedDone();
      void login.completed.catch(() => undefined);
      if (device && attempt?.state === 'pending' && !cancelling) {
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
          if (
            attempt?.attemptId === current.attemptId &&
            attempt.state === 'pending' &&
            !cancelling
          )
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
          if (
            attempt?.attemptId === current.attemptId &&
            attempt.state === 'pending' &&
            !cancelling
          )
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
      // The native adapter rejects ordinary allocation failures only after process and home cleanup;
      // cleanup uncertainty is preserved as DeviceLoginCleanupError by the host wrapper.
      allocationFailedCleanly = !cancelLogin && !(error instanceof DeviceLoginCleanupError);
      allocatedDone();
      if (error instanceof DeviceLoginCleanupError) quarantined = true;
      if (attempt?.attemptId === current.attemptId && attempt.state === 'pending' && !cancelling)
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
    if (
      !attempt ||
      owner !== getOwner(req, res) ||
      req.body?.attemptId !== attempt.attemptId ||
      (req.body?.connectionId !== undefined && req.body.connectionId !== attempt.connectionId)
    ) {
      res.json({ state: 'unknown' });
      return;
    }
    if (attempt.state !== 'pending') {
      res.json(publicReceipt());
      return;
    }
    const requestedOwner = owner;
    const requestedAttempt = attempt.attemptId;
    await cleanupAttempt('cancelled');
    res.json(
      owner === requestedOwner && attempt?.attemptId === requestedAttempt
        ? publicReceipt()
        : retainedReceipt(requestedOwner, requestedAttempt),
    );
  };
  return { start, status, cancel };
}
