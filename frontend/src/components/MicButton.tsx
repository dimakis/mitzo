// Push-to-talk mic button for voice capture.
// Hold to record, release to send, drag away to cancel.
// Uses touch events on mobile (iOS WebKit ignores pointer events on buttons)
// with pointer events as desktop fallback.

import { useRef } from 'react';

interface Props {
  available: boolean;
  recording: boolean;
  transcribing: boolean;
  micBlocked: boolean;
  onRecordStart: () => void;
  onRecordStop: () => void;
  onRecordCancel: () => void;
}

export function MicButton({
  available,
  recording,
  transcribing,
  micBlocked,
  onRecordStart,
  onRecordStop,
  onRecordCancel,
}: Props) {
  const touchActiveRef = useRef(false);

  if (!available) return null;

  if (micBlocked) {
    return (
      <button className="mic-btn mic-btn--blocked" title="Microphone blocked" disabled>
        <span className="mic-btn-icon">&#x1F507;</span>
      </button>
    );
  }

  const stateClass = recording ? 'mic-btn--recording' : transcribing ? 'mic-btn--transcribing' : '';

  const title = recording ? 'Release to send' : transcribing ? 'Transcribing...' : 'Hold to record';

  return (
    <button
      className={`mic-btn ${stateClass}`.trim()}
      title={title}
      disabled={transcribing}
      style={{ touchAction: 'none' }}
      onTouchStart={(e) => {
        if (transcribing) return;
        e.preventDefault();
        touchActiveRef.current = true;
        onRecordStart();
      }}
      onTouchEnd={() => {
        if (!touchActiveRef.current) return;
        touchActiveRef.current = false;
        if (recording) onRecordStop();
      }}
      onTouchCancel={() => {
        if (!touchActiveRef.current) return;
        touchActiveRef.current = false;
        if (recording) onRecordCancel();
      }}
      onPointerDown={(e) => {
        if (transcribing || touchActiveRef.current) return;
        e.preventDefault();
        onRecordStart();
      }}
      onPointerUp={() => {
        if (touchActiveRef.current) return;
        if (recording) onRecordStop();
      }}
      onPointerLeave={() => {
        if (touchActiveRef.current) return;
        if (recording) onRecordCancel();
      }}
    >
      <span className="mic-btn-icon">{transcribing ? '\u23F3' : '\uD83C\uDF99\uFE0F'}</span>
    </button>
  );
}
