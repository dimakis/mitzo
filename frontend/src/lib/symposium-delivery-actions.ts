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
