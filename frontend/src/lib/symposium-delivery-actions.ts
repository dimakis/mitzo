import { apiFetch } from './api-fetch';

type DeliveryAction = {
  approve?: boolean;
  send?: boolean;
  stop?: boolean;
  stopRequested?: boolean;
  notice: string;
  dispatchUncertain?: boolean;
  sendRequested?: boolean;
};
type DeliveryActions = Record<string, DeliveryAction>;

/** Page-lifetime safeguards survive keyed chat remounts. Keys include the session
 * API base and delivery ID. Unmounting never releases an uncertain Send fence.
 * This stores only action state, not credentials or conversation content.
 */
export function createSymposiumDeliveryActions() {
  let actions: DeliveryActions = {};
  const listeners = new Set<() => void>();
  return {
    activeActions: new Set<string>(),
    dispatchRequests: new Set<string>(),
    retryKeys: new Map<string, string>(),
    snapshot: () => actions,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (change: (old: DeliveryActions) => DeliveryActions) => {
      actions = change(actions);
      listeners.forEach((listener) => listener());
    },
  };
}

const deliveryActions = createSymposiumDeliveryActions();
export const getSymposiumDeliveryActions = () => deliveryActions;

class DeliveryRequestError extends Error {
  constructor(
    message: string,
    readonly dispatchNotStarted: boolean,
  ) {
    super(message);
  }
}
async function readJson(url: string, init: RequestInit): Promise<void> {
  const response = await apiFetch(url, init);
  const body = await response.json();
  if (!response.ok)
    throw new DeliveryRequestError(
      body.error || `Request failed (${response.status})`,
      body.dispatch === 'not-started',
    );
}
/** Conversation and director controls share one dispatch identity and uncertain-action fence. */
export async function controlSymposiumDelivery(
  deliveryStore: ReturnType<typeof createSymposiumDeliveryActions>,
  base: string,
  deliveryId: string,
  action: 'approve' | 'send' | 'stop',
): Promise<boolean> {
  const identity = `${base}:${deliveryId}`;
  const actionIdentity = `${identity}:${action}`;
  if (deliveryStore.activeActions.has(actionIdentity)) return false;
  if (
    action === 'send' &&
    (deliveryStore.dispatchRequests.has(identity) ||
      deliveryStore.snapshot()[identity]?.stopRequested)
  )
    return false;
  if (action === 'send') deliveryStore.dispatchRequests.add(identity);
  deliveryStore.activeActions.add(actionIdentity);
  deliveryStore.update((old) => ({
    ...old,
    [identity]: {
      ...old[identity],
      [action]: true,
      ...(action === 'send' ? { sendRequested: true } : {}),
      ...(action === 'stop' ? { stopRequested: true } : {}),
      notice:
        action === 'stop'
          ? 'Stopping… awaiting cancellation confirmation.'
          : action === 'send'
            ? 'Sending… awaiting delivery confirmation.'
            : 'Approving…',
    },
  }));
  const fingerprint = `${identity}:${action}`;
  const key = deliveryStore.retryKeys.get(fingerprint) ?? crypto.randomUUID();
  if (action !== 'send') deliveryStore.retryKeys.set(fingerprint, key);
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Send and cancellation can await native work. Bound the complete response
    // read while retaining the action's original identity after an uncertain wait.
    await Promise.race([
      readJson(
        `${base}/deliveries/${encodeURIComponent(deliveryId)}/${action === 'approve' ? 'interventions' : action === 'send' ? 'dispatch' : 'cancel'}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            action === 'approve'
              ? { action: 'approve', idempotencyKey: key }
              : action === 'stop'
                ? { reason: 'Stopped from conversation', idempotencyKey: key }
                : {},
          ),
        },
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => {
            reject(
              new Error('The action request timed out; its saved outcome remains unconfirmed.'),
            );
            controller.abort();
          },
          action === 'approve' ? 30_000 : 5 * 60 * 1000,
        );
      }),
    ]);
    deliveryStore.retryKeys.delete(fingerprint);
    deliveryStore.update((old) => ({
      ...old,
      [identity]: {
        ...old[identity],
        [action]: false,
        notice:
          action === 'send' && old[identity]?.stopRequested
            ? old[identity].notice
            : action === 'stop'
              ? 'Cancellation recorded. Provider work may still be finishing; history is preserved.'
              : action === 'send'
                ? 'Send request completed. See delivery status below.'
                : 'Approved. Choose Send to execute.',
      },
    }));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Request failed';
    const dispatchNotStarted =
      action === 'send' && cause instanceof DeliveryRequestError && cause.dispatchNotStarted;
    if (dispatchNotStarted) deliveryStore.dispatchRequests.delete(identity);
    deliveryStore.update((old) => ({
      ...old,
      [identity]: {
        ...old[identity],
        [action]: false,
        ...(dispatchNotStarted ? { sendRequested: false, dispatchUncertain: false } : {}),
        ...(!dispatchNotStarted
          ? { dispatchUncertain: action === 'send' || old[identity]?.dispatchUncertain }
          : {}),
        notice:
          action === 'send' && old[identity]?.stopRequested
            ? old[identity].notice
            : action === 'send'
              ? dispatchNotStarted
                ? `Send did not start. Check the connection, then choose Send again. ${detail}`
                : `Send outcome is uncertain. Do not resend; check delivery status or Stop. ${detail}`
              : action === 'stop'
                ? `Stop is unconfirmed. Check status or retry Stop. ${detail}`
                : `Approval is unconfirmed. Check status or retry approval. ${detail}`,
      },
    }));
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    deliveryStore.activeActions.delete(actionIdentity);
  }
  return true;
}
