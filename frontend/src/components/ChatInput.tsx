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
import { MicButton } from './MicButton';
import type { UseVoiceReturn } from '../hooks/useVoice';

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => boolean;
  onStop: () => void;
  onInterrupt?: (text: string, images?: ImageAttachment[]) => void;
  running: boolean;
  initialText?: string;
  cwd?: string;
  voice?: UseVoiceReturn;
}

export function ChatInput({
  onSend,
  onStop,
  onInterrupt,
  running,
  initialText,
  cwd,
  voice,
}: Props) {
  const [text, setText] = useState(initialText || '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
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
    );
    if (sent) {
      setText('');
      setImages([]);
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

  function handleInterrupt() {
    if (!onInterrupt) return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    onInterrupt(
      trimmed || 'What do you see in this image?',
      images.length > 0 ? images : undefined,
    );
    setText('');
    setImages([]);
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
      <div className="chat-input-row">
        <div className="chat-input-actions">
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
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            capture="environment"
            onChange={handleFileChange}
            className="sr-only"
          />
        </div>
        {voice && (
          <MicButton
            available={voice.available}
            recording={voice.recording}
            transcribing={voice.transcribing}
            micBlocked={voice.micBlocked}
            onRecordStart={voice.startRecording}
            onRecordStop={async () => {
              const transcript = await voice.stopRecording();
              if (transcript) {
                setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
                textareaRef.current?.focus();
              }
            }}
            onRecordCancel={voice.cancelRecording}
          />
        )}
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
      </div>
    </div>
  );
}
