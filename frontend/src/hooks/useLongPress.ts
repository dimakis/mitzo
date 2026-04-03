import { useRef, useCallback } from 'react';

export function useLongPress(callback: () => void, ms = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firedRef = useRef(false);

  const start = useCallback(() => {
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

  return { start, cancel, didFire };
}
