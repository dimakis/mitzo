// Toggle mic button for voice capture.
// Tap to start recording, tap again to stop and send.

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

  const title = recording ? 'Tap to stop' : transcribing ? 'Transcribing...' : 'Tap to record';

  return (
    <button
      className={`mic-btn ${stateClass}`.trim()}
      title={title}
      disabled={transcribing}
      onClick={() => {
        if (transcribing) return;
        if (recording) {
          onRecordStop();
        } else {
          onRecordStart();
        }
      }}
    >
      <span className="mic-btn-icon">{transcribing ? '\u23F3' : '\uD83C\uDF99\uFE0F'}</span>
    </button>
  );
}
