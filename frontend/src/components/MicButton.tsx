// Push-to-talk mic button for voice capture.
// Hold to record, release to send, drag away to cancel.

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
      onPointerDown={(e) => {
        if (transcribing) return;
        e.preventDefault();
        onRecordStart();
      }}
      onPointerUp={() => {
        if (recording) onRecordStop();
      }}
      onPointerLeave={() => {
        if (recording) onRecordCancel();
      }}
    >
      <span className="mic-btn-icon">{transcribing ? '\u23F3' : '\uD83C\uDF99\uFE0F'}</span>
    </button>
  );
}
