import { useContext, type ReactNode } from 'react';
import { SeatColors } from '../lib/seat-color-context';

export function SeatColorProvider({
  roster,
  children,
}: {
  roster?: readonly string[];
  children: ReactNode;
}) {
  const inherited = useContext(SeatColors);
  return <SeatColors.Provider value={roster ?? inherited}>{children}</SeatColors.Provider>;
}
