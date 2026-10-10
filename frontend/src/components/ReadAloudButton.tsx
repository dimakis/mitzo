import { UiIcon } from './UiIcon';
interface ReadAloudButtonProps {
  text: string;
  active: boolean;
  onSpeak: (text: string) => void;
  onStop: () => void;
  className?: string;
}

export function ReadAloudButton({
  text,
  active,
  onSpeak,
  onStop,
  className,
}: ReadAloudButtonProps) {
  return (
    <button
      className={`read-aloud-btn ${active ? 'read-aloud-btn--active' : ''} ${className ?? ''}`.trim()}
      aria-label={active ? 'Stop reading' : 'Read aloud'}
      onClick={() => (active ? onStop() : onSpeak(text))}
    >
      <UiIcon name={active ? 'stop' : 'volume'} size={16} />
    </button>
  );
}
