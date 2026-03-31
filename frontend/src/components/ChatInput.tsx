import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';

export interface ImageAttachment {
  data: string;
  mediaType: string;
  preview: string;
}

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  running: boolean;
  initialText?: string;
}

const MAX_IMAGES = 4;
const MAX_DIMENSION = 1600;

function resizeImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const scale = MAX_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas not supported'));

        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL(file.type || 'image/jpeg', 0.85);
        const [header, data] = dataUrl.split(',');
        const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';

        resolve({ data, mediaType, preview: dataUrl });
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
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
    if ((!trimmed && images.length === 0) || running) return;
    onSend(trimmed || 'What do you see in this image?', images.length > 0 ? images : undefined);
    setText('');
    setImages([]);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
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

    const remaining = MAX_IMAGES - images.length;
    const toProcess = Array.from(files).slice(0, remaining);

    for (const file of toProcess) {
      try {
        const attachment = await resizeImage(file);
        setImages((prev) => [...prev, attachment]);
      } catch (err) {
        console.error('Failed to process image:', err);
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  const canSend = text.trim() || images.length > 0;

  return (
    <div className="chat-input">
      {running && <div className="chat-input-thinking">Thinking</div>}
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
          disabled={running || images.length >= MAX_IMAGES}
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
          placeholder={running ? 'Working...' : 'Message Mitzo...'}
          rows={1}
          disabled={running}
        />
        {running ? (
          <button className="chat-input-btn chat-input-btn--stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button
            className="chat-input-btn chat-input-btn--send"
            onClick={handleSend}
            disabled={!canSend}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
