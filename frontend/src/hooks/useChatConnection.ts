import { useState, useEffect } from 'react';
import { wsSubscribe, wsIsOpen, wsRemoveIfIdle } from '../lib/ws-pool';
import type { WsMsg } from '../lib/ws-pool';

export function useChatConnection(
  poolKey: string,
  ...handlers: ((msg: WsMsg) => void)[]
): { connected: boolean } {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const wrappedHandler = (msg: WsMsg) => {
      if (msg.type === '_open' || msg.type === 'reattached') {
        setConnected(true);
      } else if (msg.type === '_close') {
        setConnected(false);
      }
      for (const h of handlers) h(msg);
    };

    const unsubscribe = wsSubscribe(poolKey, wrappedHandler);

    setConnected(wsIsOpen(poolKey));

    return () => {
      unsubscribe();
      wsRemoveIfIdle(poolKey);
    };
  }, [poolKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected };
}
