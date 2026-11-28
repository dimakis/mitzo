import { createContext, useContext } from 'react';
import { seatAccentColor } from './seat-color';

export const SeatColors = createContext<readonly string[]>([]);
export function useSeatAccentColor() {
  const roster = useContext(SeatColors);
  return (id: string) => seatAccentColor(id, roster);
}
