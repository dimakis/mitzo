import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '../styles/home.css';

export function HomeDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef(document.activeElement);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const focus = restoreFocus.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="home-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="home-dialog-content">
        <header>
          <h2>{title}</h2>
          <button type="button" className="home-secondary" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
