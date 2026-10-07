import { useRef, useCallback, useEffect } from 'react';

export function useLongPress(callback: () => void, ms = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firedRef = useRef(false);

  const start = useCallback(() => {
    clearTimeout(timerRef.current);
    firedRef.current = false;
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      callback();
    }, ms);
  }, [callback, ms]);

  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  const didFire = useCallback(() => firedRef.current, []);

  const consumeClick = useCallback(() => {
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, []);

  useEffect(() => cancel, [cancel]);

  return { start, cancel, didFire, consumeClick };
}
