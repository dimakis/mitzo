import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import type { ImageAttachment } from '../types/chat';
import { resizeImage } from '../lib/resizeImage';
import { extractImageFiles } from '../lib/paste-images';
import { MAX_IMAGE_ATTACHMENTS } from '../lib/constants';
import { SlashPicker } from './SlashPicker';
import { ContextPicker } from './ContextPicker';
import { MicButton } from './MicButton';
import { impactMedium } from '../lib/haptics';
import { TokenBar } from './TokenBar';
import type { UseVoiceReturn } from '../hooks/useVoice';
import type { TokensState as TokenState } from '@mitzo/client';

interface Props {
  onSend: (text: string, images?: ImageAttachment[], contextBlocks?: string[]) => boolean;
  onStop: () => void;
  onInterrupt?: (text: string, images?: ImageAttachment[], contextBlocks?: string[]) => void;
  running: boolean;
  initialText?: string;
  cwd?: string;
  voice?: UseVoiceReturn;
  branch?: string;
  isWorktree?: boolean;
  wtId?: string;
  sessionId?: string;
  /** When provided, uses these context blocks instead of internal state. Hides @ picker. */
  externalContextBlocks?: string[];
  tokenState?: TokenState;
}

export function ChatInput({
  onSend,
  onStop,
  onInterrupt,
  running,
  initialText,
  cwd,
  voice,
  branch,
  isWorktree,
  wtId,
  sessionId,
  externalContextBlocks,
  tokenState,
}: Props) {
  const [text, setText] = useState(initialText || '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextBlocks, setContextBlocks] = useState<string[]>([]);
  const useExternal = externalContextBlocks !== undefined;
  const activeContextBlocks = useExternal ? externalContextBlocks : contextBlocks;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialApplied = useRef(false);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialText && !initialApplied.current) {
      initialApplied.current = true;
      setText(initialText);
      requestAnimationFrame(() => {
        autoResize();
        textareaRef.current?.focus();
      });
    }
  }, [initialText, autoResize]);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  // Show/hide slash picker based on input
  // TODO: Verify picker reopens correctly on backspace after space (e.g. "/simplify " → "/simplify")
  useEffect(() => {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      setShowSlashPicker(true);
    } else if (!trimmed.startsWith('/')) {
      setShowSlashPicker(false);
    }
  }, [text]);

  function handleSlashSelect(name: string) {
    setText(`/${name} `);
    setShowSlashPicker(false);
    textareaRef.current?.focus();
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const sent = onSend(
      trimmed || 'What do you see in this image?',
      images.length > 0 ? images : undefined,
      activeContextBlocks.length > 0 ? activeContextBlocks : undefined,
    );
    if (sent) {
      impactMedium();
      setText('');
      setImages([]);
      if (!useExternal) setContextBlocks([]);
      requestAnimationFrame(() => {
        autoResize();
        textareaRef.current?.focus();
      });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;

    const remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    const toProcess = Array.from(files).slice(0, remaining);

    for (const file of toProcess) {
      try {
        const attachment = await resizeImage(file);
        setImages((prev) => [...prev, attachment]);
      } catch {
        // Image resize failed — skip this attachment silently
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    if (remaining <= 0) return;

    const files = extractImageFiles(e.clipboardData.items, remaining);
    if (files.length === 0) return;

    e.preventDefault();
    for (const file of files) {
      try {
        const attachment = await resizeImage(file);
        setImages((prev) => [...prev, attachment]);
      } catch {
        // Image resize failed — skip silently
      }
    }
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  const canSend = text.trim() || images.length > 0;

  const micProps = voice
    ? {
        available: voice.available,
        recording: voice.recording,
        transcribing: voice.transcribing,
        micBlocked: voice.micBlocked,
        onRecordStart: voice.startRecording,
        onRecordStop: async () => {
          const transcript = await voice.stopRecording();
          if (transcript) {
            setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
            textareaRef.current?.focus();
          }
        },
        onRecordCancel: voice.cancelRecording,
      }
    : null;

  function handleInterrupt() {
    if (!onInterrupt) return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    onInterrupt(
      trimmed || 'What do you see in this image?',
      images.length > 0 ? images : undefined,
      activeContextBlocks.length > 0 ? activeContextBlocks : undefined,
    );
    setText('');
    setImages([]);
    if (!useExternal) setContextBlocks([]);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  return (
    <div className="chat-input">
      {showSlashPicker && (
        <SlashPicker
          query={text.trimStart()}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashPicker(false)}
          cwd={cwd}
        />
      )}
      {!useExternal && showContextPicker && (
        <ContextPicker
          selected={contextBlocks}
          onToggle={(name) =>
            setContextBlocks((prev) =>
              prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
            )
          }
          onClose={() => setShowContextPicker(false)}
        />
      )}
      {images.length > 0 && (
        <div className="chat-input-previews">
          {images.map((img, i) => (
            <div key={i} className="chat-input-preview">
              <img src={img.preview} alt={`Attachment ${i + 1}`} />
              <button className="chat-input-preview-remove" onClick={() => removeImage(i)}>
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
      {!useExternal && contextBlocks.length > 0 && (
        <div className="chat-input-context-pills">
          {contextBlocks.map((name) => (
            <span key={name} className="chat-input-context-pill">
              {name}
              <button
                className="chat-input-context-pill-remove"
                onClick={() => setContextBlocks((prev) => prev.filter((n) => n !== name))}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      {voice?.recording && voice.partialTranscript && (
        <div className="voice-partial">{voice.partialTranscript}</div>
      )}
      <div className="chat-input-command-strip">
        <button
          className="chat-input-btn chat-input-btn--skills"
          onClick={() => {
            if (!text.startsWith('/')) setText('/');
            setShowSlashPicker(true);
            textareaRef.current?.focus();
          }}
          title="Skills"
        >
          /
        </button>
        <button
          className="chat-input-btn chat-input-btn--attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGE_ATTACHMENTS}
          title="Attach image"
        >
          +
        </button>
        {!useExternal && (
          <button
            className={`chat-input-btn chat-input-btn--context${contextBlocks.length > 0 ? ' chat-input-btn--active' : ''}`}
            onClick={() => setShowContextPicker((v) => !v)}
            title="Attach context"
          >
            @
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          capture="environment"
          onChange={handleFileChange}
          className="sr-only"
        />
        {sessionId && (
          <span className="chat-input-session-hash" title={`session: ${sessionId}`}>
            {sessionId.slice(-5)}
          </span>
        )}
        {(branch || wtId) && (
          <span
            className={`chat-input-branch${isWorktree ? ' chat-input-branch--wt' : ''}`}
            title={isWorktree && wtId ? `session: ${wtId}\nbranch: ${branch}` : branch || ''}
          >
            {isWorktree && wtId ? wtId.slice(-6) : branch}
          </span>
        )}
        {tokenState && <TokenBar tokenState={tokenState} />}
      </div>
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input-field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={running ? 'Type to queue or interrupt...' : 'Message Mitzo...'}
          rows={1}
        />
        {running ? (
          <>
            {canSend && onInterrupt && (
              <button
                className="chat-input-btn chat-input-btn--interrupt"
                onClick={handleInterrupt}
                title="Interrupt — send now, mid-thinking"
              >
                ↯
              </button>
            )}
            {canSend && (
              <button
                className="chat-input-btn chat-input-btn--send"
                onClick={handleSend}
                title="Queue — send after current turn"
              >
                ↑
              </button>
            )}
            <button className="chat-input-btn chat-input-btn--stop" onClick={onStop}>
              ■
            </button>
          </>
        ) : (
          <button
            className="chat-input-btn chat-input-btn--send"
            onClick={handleSend}
            disabled={!canSend}
          >
            ↑
          </button>
        )}
        {micProps && <MicButton {...micProps} />}
      </div>
    </div>
  );
}
