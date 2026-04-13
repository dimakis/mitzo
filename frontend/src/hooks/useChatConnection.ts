import { useState, useEffect, useRef } from 'react';
import { wsSubscribe, wsIsOpen, wsRemoveIfIdle } from '../lib/ws-pool';
import type { WsMsg } from '../lib/ws-pool';

export function useChatConnection(
  poolKey: string,
  ...handlers: ((msg: WsMsg) => void)[]
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const wrappedHandler = (msg: WsMsg) => {
      if (msg.type === '_open' || msg.type === 'reattached') {
        setConnected(true);
      } else if (msg.type === '_close') {
        setConnected(false);
      }
      for (const h of handlersRef.current) h(msg);
    };

    const unsubscribe = wsSubscribe(poolKey, wrappedHandler);

    setConnected(wsIsOpen(poolKey));

    return () => {
      unsubscribe();
      wsRemoveIfIdle(poolKey);
    };
  }, [poolKey]);

  return { connected };
}
