import { useState } from 'react';
import type { Session } from '../types/chat';

/** Keep browsing positions stable for this visit, including across history refreshes.
 * New rows use their observed chronology; displayed metadata always stays live.
 */
export function useStableSessionOrder(sessions: Session[]): Session[] {
  const [observedTimes, setObservedTimes] = useState(() => new Map<string, number>());
  let times = observedTimes;
  for (const session of sessions) {
    if (times.has(session.id)) continue;
    if (times === observedTimes) times = new Map(observedTimes);
    times.set(session.id, session.lastModified);
  }
  if (times !== observedTimes) setObservedTimes(times);

  return [...sessions].sort(
    (a, b) => times.get(b.id)! - times.get(a.id)! || a.id.localeCompare(b.id),
  );
}
