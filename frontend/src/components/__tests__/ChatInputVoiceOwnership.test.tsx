// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatInput } from '../ChatInput';
import type { UseVoiceReturn } from '../../hooks/useVoice';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../lib/chat-drafts';
const microphone = vi.hoisted(() => ({
  current: null as null | {
    onRecordStart(): void | Promise<void>;
    onRecordStop(): void | Promise<void>;
    onRecordCancel(): void;
  },
}));
vi.mock('../MicButton', () => ({
  MicButton: (props: NonNullable<typeof microphone.current>) => {
    microphone.current = props;
    return null;
  },
}));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
vi.mock('../SessionTray', () => ({ SessionTray: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  microphone.current = null;
});
function makeVoice(overrides: Partial<UseVoiceReturn> = {}): UseVoiceReturn {
  return {
    available: true,
    recording: true,
    transcribing: false,
    partialTranscript: '',
    micBlocked: false,
    error: null,
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => 'transcript'),
    cancelRecording: vi.fn(),
    ttsAvailable: false,
    speaking: false,
    voices: [],
    selectedVoice: '',
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    setVoice: vi.fn(),
    ...overrides,
  };
}
function saved(text: string) {
  const draft = { ...createChatDraft(), text };
  saveChatDraft(draft);
  return draft;
}
const base = { onSend: () => false, onStop: () => {}, running: false };
it.each(['new', 'draft', 'return', 'unmount'] as const)(
  'cancels pending transcription after %s and refuses its old transcript',
  async (change) => {
    const first = saved('First draft');
    const second = saved('Second draft');
    let finish!: (transcript: string) => void;
    const voice = makeVoice({
      stopRecording: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const view = render(
      <ChatInput {...base} savedChatDraft={first} voice={voice} composerGeneration={0} />,
    );
    const pending = microphone.current!.onRecordStop();
    if (change === 'unmount') view.unmount();
    else {
      view.rerender(
        <ChatInput
          {...base}
          savedChatDraft={change === 'new' ? createChatDraft() : second}
          voice={voice}
          composerGeneration={change === 'new' ? 1 : 0}
        />,
      );
      if (change === 'return')
        view.rerender(
          <ChatInput {...base} savedChatDraft={first} voice={voice} composerGeneration={0} />,
        );
    }
    await act(async () => {
      finish('Old transcript');
      await pending;
    });
    expect(voice.cancelRecording).toHaveBeenCalled();
    expect(getChatDraft(first.id)?.text).toBe('First draft');
    expect(getChatDraft(second.id)?.text).toBe('Second draft');
    if (change !== 'unmount')
      expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
        'value',
        change === 'new' ? '' : change === 'return' ? 'First draft' : 'Second draft',
      );
  },
);
it('appends same-owner transcription to typing performed while the transcript was pending', async () => {
  const draft = saved('Initial words');
  let finish!: (transcript: string) => void;
  const voice = makeVoice({
    stopRecording: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  render(<ChatInput {...base} savedChatDraft={draft} voice={voice} />);
  const pending = microphone.current!.onRecordStop();
  fireEvent.change(screen.getByLabelText('Message Mitzo'), {
    target: { value: 'Edited while waiting' },
  });
  await act(async () => {
    finish('New transcript');
    await pending;
  });
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
    'value',
    'Edited while waiting New transcript',
  );
  expect(getChatDraft(draft.id)?.text).toBe('Edited while waiting New transcript');
});
it('cancels pending microphone permission on owner change and rejects old start/stop callbacks', async () => {
  const first = saved('First draft');
  const second = saved('Second draft');
  let allowMicrophone!: () => void;
  const voice = makeVoice({
    recording: false,
    startRecording: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          allowMicrophone = resolve;
        }),
    ),
  });
  const view = render(<ChatInput {...base} savedChatDraft={first} voice={voice} />);
  const oldControls = microphone.current!;
  const start = oldControls.onRecordStart();
  view.rerender(<ChatInput {...base} savedChatDraft={second} voice={voice} />);
  expect(voice.cancelRecording).toHaveBeenCalled();
  await act(async () => {
    allowMicrophone();
    await start;
    await oldControls.onRecordStop();
    await oldControls.onRecordStart();
  });
  expect(voice.startRecording).toHaveBeenCalledTimes(1);
  expect(voice.stopRecording).not.toHaveBeenCalled();
  expect(getChatDraft(second.id)?.text).toBe('Second draft');
});
it('refuses a deferred transcript after explicit cancellation in the same composer', async () => {
  const draft = saved('Keep these words');
  let finish!: (transcript: string) => void;
  const voice = makeVoice({
    stopRecording: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  render(<ChatInput {...base} savedChatDraft={draft} voice={voice} />);
  const pending = microphone.current!.onRecordStop();
  microphone.current!.onRecordCancel();
  await act(async () => {
    finish('Cancelled words');
    await pending;
  });
  expect(getChatDraft(draft.id)?.text).toBe('Keep these words');
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty('value', 'Keep these words');
});
it('keeps newer dictated words after acceptance of the older submitted draft revision', async () => {
  const draft = saved('Submitted words');
  let finish!: (transcript: string) => void;
  const voice = makeVoice({
    stopRecording: vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    ),
  });
  let accept: (() => void) | undefined;
  const send = vi.fn((_text, _images, _context, receipt) => {
    accept = () => receipt?.('accepted');
    return true;
  });
  render(<ChatInput {...base} onSend={send} savedChatDraft={draft} voice={voice} />);
  const pending = microphone.current!.onRecordStop();
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await act(async () => {
    finish('New dictated words');
    await pending;
  });
  act(() => accept?.());
  expect(send.mock.calls[0][0]).toBe('Submitted words');
  expect(getChatDraft(draft.id)?.text).toBe('Submitted words New dictated words');
  expect(screen.getByLabelText('Message Mitzo')).toHaveProperty(
    'value',
    'Submitted words New dictated words',
  );
});
