import { UiIcon } from './UiIcon';
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
        <UiIcon name="blocked" />
      </button>
    );
  }

  const stateClass = recording ? 'mic-btn--recording' : transcribing ? 'mic-btn--transcribing' : '';

  const title = recording ? 'Tap to stop' : transcribing ? 'Transcribing...' : 'Tap to record';

  return (
    <button
      className={`mic-btn ${stateClass}`.trim()}
      title={title}
      aria-label={
        recording ? 'Stop recording' : transcribing ? 'Transcribing audio' : 'Record voice message'
      }
      aria-pressed={recording}
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
      <UiIcon name={transcribing ? 'loading' : recording ? 'stop' : 'mic'} />
    </button>
  );
}
