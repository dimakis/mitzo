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

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => boolean;
  onStop: () => void;
  running: boolean;
  initialText?: string;
}

export function ChatInput({ onSend, onStop, running, initialText }: Props) {
  const [text, setText] = useState(initialText || '');
  const [images, setImages] = useState<ImageAttachment[]>([]);
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

  return (
    <div className="chat-input">
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
        <button
          className="chat-input-btn chat-input-btn--attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={running || images.length >= MAX_IMAGE_ATTACHMENTS}
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
        <textarea
          ref={textareaRef}
          className="chat-input-field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={running ? 'Type next message...' : 'Message Mitzo...'}
          rows={1}
        />
        {running ? (
          <button className="chat-input-btn chat-input-btn--stop" onClick={onStop}>
            ■
          </button>
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
