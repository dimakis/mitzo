import { useSeatAccentColor } from '../lib/seat-color-context';
/** Color is decorative; the visible name carries identity for every reader. */
export function SeatLabel({ seatId, name }: { seatId: string; name: string }) {
  const seatAccentColor = useSeatAccentColor();
  return (
    <span className="symposium-seat-label">
      <span
        aria-hidden="true"
        className="symposium-seat-accent"
        data-seat-accent={seatId}
        style={{ backgroundColor: seatAccentColor(seatId) }}
      />
      {name}
    </span>
  );
}
