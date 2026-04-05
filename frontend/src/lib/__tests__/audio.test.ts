import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  negotiateMimeType,
  createRecorder,
  createStreamingRecorder,
  blobToFormData,
} from '../audio';
import { MAX_RECORDING_DURATION_MS } from '../constants';

// --- Mock MediaRecorder ---

class MockMediaRecorder {
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  static isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus');

  constructor(
    public stream: MediaStream,
    public options?: { mimeType?: string },
  ) {}

  private timesliceInterval: ReturnType<typeof setInterval> | undefined;

  start(timeslice?: number) {
    this.state = 'recording';
    if (timeslice) {
      this.timesliceInterval = setInterval(() => {
        if (this.state === 'recording') {
          this.ondataavailable?.({
            data: new Blob(['chunk'], { type: this.options?.mimeType }),
          });
        }
      }, timeslice);
    }
  }

  stop() {
    this.state = 'inactive';
    clearInterval(this.timesliceInterval);
    // Simulate async data + stop events
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['audio-data'], { type: this.options?.mimeType }) });
      this.onstop?.();
    }, 0);
  }
}

// Minimal MediaStream mock
function mockStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
  return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
}

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', MockMediaRecorder);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests ---

describe('negotiateMimeType', () => {
  it('returns webm/opus when supported', () => {
    MockMediaRecorder.isTypeSupported.mockImplementation(
      (t: string) => t === 'audio/webm;codecs=opus',
    );
    expect(negotiateMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('falls back to plain webm', () => {
    MockMediaRecorder.isTypeSupported.mockImplementation((t: string) => t === 'audio/webm');
    expect(negotiateMimeType()).toBe('audio/webm');
  });

  it('falls back to mp4 for Safari', () => {
    MockMediaRecorder.isTypeSupported.mockImplementation((t: string) => t === 'audio/mp4');
    expect(negotiateMimeType()).toBe('audio/mp4');
  });

  it('returns undefined when nothing is supported', () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(false);
    expect(negotiateMimeType()).toBeUndefined();
  });
});

describe('createRecorder', () => {
  it('returns a recorder that captures audio into a blob', async () => {
    const stream = mockStream();
    const recorder = createRecorder(stream, 'audio/webm;codecs=opus');

    recorder.start();
    // Simulate enough time passing
    const blob = await recorder.stop();

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('cancel discards recording without producing a blob', () => {
    const stream = mockStream();
    const recorder = createRecorder(stream, 'audio/webm;codecs=opus');

    recorder.start();
    recorder.cancel();

    // After cancel, the stream tracks should be stopped
    const tracks = stream.getTracks();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('auto-stops after MAX_RECORDING_DURATION_MS', () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const recorder = createRecorder(stream, 'audio/webm;codecs=opus');
    const onAutoStop = vi.fn();
    recorder.onAutoStop = onAutoStop;

    recorder.start();
    vi.advanceTimersByTime(MAX_RECORDING_DURATION_MS);

    expect(onAutoStop).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('blobToFormData', () => {
  it('creates FormData with the audio blob', () => {
    const blob = new Blob(['data'], { type: 'audio/webm;codecs=opus' });
    const fd = blobToFormData(blob);

    const file = fd.get('file') as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('recording.webm');
    expect(file.type).toBe('audio/webm;codecs=opus');
  });

  it('uses .mp4 extension for mp4 mime type', () => {
    const blob = new Blob(['data'], { type: 'audio/mp4' });
    const fd = blobToFormData(blob);

    const file = fd.get('file') as File;
    expect(file.name).toBe('recording.mp4');
  });
});

describe('createStreamingRecorder', () => {
  it('emits chunks via onChunk callback during recording', async () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const recorder = createStreamingRecorder(stream, 'audio/webm;codecs=opus', 100);
    const chunks: Blob[] = [];
    recorder.onChunk = (blob) => chunks.push(blob);

    recorder.start();

    // Advance past two timeslice intervals
    vi.advanceTimersByTime(250);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    recorder.stop();
    vi.useRealTimers();
  });

  it('fires onStop when recording ends', async () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const recorder = createStreamingRecorder(stream, 'audio/webm;codecs=opus', 100);
    const onStop = vi.fn();
    recorder.onStop = onStop;

    recorder.start();
    recorder.stop();

    // onstop fires async
    vi.advanceTimersByTime(10);
    expect(onStop).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('cancel stops without firing onStop', () => {
    const stream = mockStream();
    const recorder = createStreamingRecorder(stream, 'audio/webm;codecs=opus', 100);
    const onStop = vi.fn();
    recorder.onStop = onStop;

    recorder.start();
    recorder.cancel();

    expect(onStop).not.toHaveBeenCalled();
    const tracks = stream.getTracks();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('auto-stops after MAX_RECORDING_DURATION_MS', () => {
    vi.useFakeTimers();
    const stream = mockStream();
    const recorder = createStreamingRecorder(stream, 'audio/webm;codecs=opus', 100);
    const onAutoStop = vi.fn();
    recorder.onAutoStop = onAutoStop;

    recorder.start();
    vi.advanceTimersByTime(MAX_RECORDING_DURATION_MS);

    expect(onAutoStop).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
