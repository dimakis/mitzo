import { useCopyFeedback } from '../hooks/useCopyFeedback';

interface CopyButtonProps {
  text: string;
  className?: string;
  label?: string;
}

export function CopyButton({ text, className, label = 'Copy to clipboard' }: CopyButtonProps) {
  const { copied, copy } = useCopyFeedback();

  return (
    <button
      className={`copy-btn ${className ?? ''} ${copied ? 'copy-btn--copied' : ''}`.trim()}
      aria-label={copied ? 'Copied' : label}
      onClick={() => copy(text)}
    >
      {copied ? '✓' : '⎘'}
    </button>
  );
}
