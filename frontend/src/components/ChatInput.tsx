import { MotionPresence } from './MotionPresence';
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  type RefObject,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import type { BootContextMeta, SendMessageOptions } from '@mitzo/client';
import type { FinishedMessage, ImageAttachment, StreamingMessage } from '../types/chat';
import { resizeImage } from '../lib/resizeImage';
import { extractImageFiles } from '../lib/paste-images';
import { MAX_IMAGE_ATTACHMENTS } from '../lib/constants';
import { SlashPicker } from './SlashPicker';
import { SessionTray } from './SessionTray';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { ComposerTools } from './ComposerTools';
import { UiIcon } from './UiIcon';
import { MicButton } from './MicButton';
import { impactMedium } from '../lib/haptics';
import { TokenBar } from './TokenBar';
import type { UseVoiceReturn } from '../hooks/useVoice';
import type { TokensState as TokenState } from '@mitzo/client';
import { useDraft, type DraftSessionAssignment } from '../hooks/useDraft';
import { useQueuedMessages } from '../hooks/useQueuedMessages';
import {
  type ChatDraft,
  chatDraftStorageKey,
  getChatDraft,
  saveChatDraft,
  consumeChatDraft,
} from '../lib/chat-drafts';

export interface ChatInputDraftControl {
  storageKey: string | undefined;
  clear: () => void;
}

interface Props {
  onSend: (
    text: string,
    images?: ImageAttachment[],
    contextBlocks?: string[],
    onDelivery?: SendMessageOptions['onDelivery'],
    onSessionAssigned?: SendMessageOptions['onSessionAssigned'],
  ) => boolean;
  onStop: () => void;
  onInterrupt?: (
    text: string,
    images?: ImageAttachment[],
    contextBlocks?: string[],
    onDelivery?: SendMessageOptions['onDelivery'],
  ) => void;
  running: boolean;
  initialText?: string;
  /** Prompt storage ownership independent of the provider session identity. */
  draftStorageKey?: string;
  savedChatDraft?: ChatDraft;
  draftControl?: RefObject<ChatInputDraftControl | null>;
  sendDisabledReason?: string;
  boundedFirstCommand?: boolean;
  /** Validate the actual edited payload against the selected route before sending. */
  validateSend?: (text: string, images?: ImageAttachment[]) => string | undefined;
  cwd?: string;
  voice?: UseVoiceReturn;
  branch?: string;
  isWorktree?: boolean;
  isolation?: boolean;
  onIsolationChange?: (enabled: boolean) => void;
  wtId?: string;
  sessionId?: string;
  /** Advances for a genuine New/reset, independently of authenticated assignment. */
  composerGeneration?: number;
  /** When provided, uses these context blocks instead of internal state. Hides @ picker. */
  externalContextBlocks?: string[];
  tokenState?: TokenState;
  messages?: FinishedMessage[];
  current?: StreamingMessage | null;
  bootContext?: BootContextMeta | null;
  sessionContext?: string | null;
}

const EMPTY_MESSAGES: FinishedMessage[] = [];

export function ChatInput({
  onSend,
  onStop,
  onInterrupt,
  running,
  initialText,
  draftStorageKey: suppliedDraftStorageKey,
  savedChatDraft,
  draftControl,
  sendDisabledReason: suppliedSendDisabledReason,
  boundedFirstCommand = false,
  validateSend,
  cwd,
  voice,
  branch,
  isWorktree,
  wtId,
  isolation,
  onIsolationChange,
  sessionId,
  composerGeneration = 0,
  externalContextBlocks,
  tokenState,
  messages = EMPTY_MESSAGES,
  current,
  bootContext,
  sessionContext,
}: Props) {
  const draftStorageKey = savedChatDraft
    ? chatDraftStorageKey(savedChatDraft.id)
    : suppliedDraftStorageKey;
  const sendPending = useRef<{ assignedSessionId?: string } | null>(null);
  // Acceptance can precede the routed render. Keep its exact assignment until
  // that ownership transfer is applied, independently of the pending receipt.
  const assignedDraft = useRef<{
    assignment: DraftSessionAssignment;
    composerGeneration: number;
  } | null>(null);
  const proof = assignedDraft.current;
  if (
    proof &&
    (proof.composerGeneration !== composerGeneration ||
      (sessionId !== proof.assignment.fromSessionId && sessionId !== proof.assignment.toSessionId))
  )
    assignedDraft.current = null;
  const assignment =
    draftStorageKey === undefined ? (assignedDraft.current?.assignment ?? null) : null;
  const [text, setText, clearDraft, flushDraft] = useDraft(
    sessionId,
    initialText ?? savedChatDraft?.text,
    draftStorageKey,
    assignment,
  );
  useImperativeHandle(draftControl, () => ({ storageKey: draftStorageKey, clear: clearDraft }), [
    draftStorageKey,
    clearDraft,
  ]);
  const [images, setImages] = useState<ImageAttachment[]>(savedChatDraft?.images ?? []);
  const [preview, setPreview] = useState<{
    image: ImageAttachment;
    sessionId: string | undefined;
    composerGeneration: number;
    draftStorageKey: string | undefined;
  } | null>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewScope = useRef({ sessionId, composerGeneration, draftStorageKey });
  previewScope.current = { sessionId, composerGeneration, draftStorageKey };
  const imageKeys = useRef(new WeakMap<ImageAttachment, number>());
  const nextImageKey = useRef(0);
  const previewOpen =
    preview !== null &&
    preview.sessionId === sessionId &&
    preview.composerGeneration === composerGeneration &&
    preview.draftStorageKey === draftStorageKey &&
    images.includes(preview.image);
  if (preview && !previewOpen) setPreview(null);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [contextBlocks, setContextBlocks] = useState<string[]>(savedChatDraft?.contextBlocks ?? []);
  const {
    queue: queuedMessages,
    enqueue,
    dequeue,
    restoreRejected,
    removeSubmitted,
    remove: removeQueued,
    edit: editQueued,
  } = useQueuedMessages(sessionId, 5, assignment);
  useEffect(() => {
    if (
      assignment &&
      sessionId === assignment.toSessionId &&
      assignedDraft.current?.assignment === assignment
    )
      assignedDraft.current = null;
  }, [assignment, sessionId]);
  const useExternal = externalContextBlocks !== undefined;
  const activeContextBlocks = useExternal ? externalContextBlocks : contextBlocks;
  const sendDisabledReason =
    suppliedSendDisabledReason ??
    (boundedFirstCommand && activeContextBlocks.length
      ? 'Remove attached context before sending the Local command.'
      : undefined) ??
    validateSend?.(
      text.trim() || 'What do you see in this image?',
      images.length ? images : undefined,
    );
  const previousSavedId = useRef(savedChatDraft?.id);
  const savedOwnerChanging = previousSavedId.current !== savedChatDraft?.id;
  useEffect(() => {
    if (!savedOwnerChanging) return;
    previousSavedId.current = savedChatDraft?.id;
    setImages(savedChatDraft?.images ?? []);
    if (!useExternal) setContextBlocks(savedChatDraft?.contextBlocks ?? []);
  }, [savedChatDraft, savedOwnerChanging, useExternal]);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    if (!savedChatDraft || savedOwnerChanging) return;
    const current = getChatDraft(savedChatDraft.id) ?? savedChatDraft;
    setSaveFailed(
      !saveChatDraft({
        ...current,
        settings: savedChatDraft.settings,
        text,
        images,
        contextBlocks: activeContextBlocks,
      }),
    );
  }, [savedChatDraft, savedOwnerChanging, text, images, activeContextBlocks]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initialApplied = useRef(false);
  const prevRunning = useRef({ running, sessionId, composerGeneration, draftStorageKey });
  if (
    prevRunning.current.sessionId !== sessionId ||
    prevRunning.current.composerGeneration !== composerGeneration ||
    prevRunning.current.draftStorageKey !== draftStorageKey
  ) {
    // A deferred completion authorizes only the queue owned by that draft.
    prevRunning.current = { running, sessionId, composerGeneration, draftStorageKey };
  }
  const sendGuard = useRef(false);
  const interruptPending = useRef<object | null>(null);
  const mounted = useRef(true);
  const voiceOperation = useRef<{ scope: number } | null>(null);
  const latestDraft = useRef({
    text,
    images,
    contextBlocks: activeContextBlocks,
    sessionId,
    composerGeneration,
    draftStorageKey,
    scope: 0,
    revision: 0,
  });
  const previous = latestDraft.current;
  const generationChanged = previous.composerGeneration !== composerGeneration;
  const scopeChanged =
    previous.sessionId !== sessionId ||
    previous.draftStorageKey !== draftStorageKey ||
    generationChanged;
  if (scopeChanged) {
    interruptPending.current = null;
    if (generationChanged || sendPending.current?.assignedSessionId !== sessionId)
      sendPending.current = null;
    if (generationChanged) sendGuard.current = false;
  }
  latestDraft.current = {
    text,
    images,
    contextBlocks: activeContextBlocks,
    sessionId,
    composerGeneration,
    draftStorageKey,
    scope: previous.scope + (scopeChanged ? 1 : 0),
    revision:
      previous.revision +
      (previous.text !== text ||
      previous.images !== images ||
      previous.contextBlocks !== activeContextBlocks ||
      scopeChanged
        ? 1
        : 0),
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const composerScope = latestDraft.current.scope;
  const cancelRecording = voice?.cancelRecording;
  useEffect(
    () => () => {
      if (voiceOperation.current?.scope === composerScope) voiceOperation.current = null;
      // This also invalidates pending microphone permission and aborts STT.
      cancelRecording?.();
    },
    [composerScope, cancelRecording],
  );

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  useEffect(() => {
    // Returning routes may mount after a user has focused a file control.
    if (document.activeElement === document.body) textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialText && !initialApplied.current) {
      initialApplied.current = true;
      requestAnimationFrame(() => {
        autoResize();
        textareaRef.current?.focus();
      });
    }
  }, [initialText, autoResize]);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const sendOrdinary = useCallback(
    (
      payload: { text: string; images: ImageAttachment[]; contextBlocks: string[] },
      queued = false,
    ): boolean => {
      if (queued && (boundedFirstCommand || sendDisabledReason)) return false;
      const submitted = latestDraft.current;
      const submittedSavedDraft = savedChatDraft ? getChatDraft(savedChatDraft.id) : null;
      const pending: { assignedSessionId?: string } = {};
      sendPending.current = pending;
      // Keep dequeued input under the existing explicit-retry fence until a
      // definitive receipt. A missing receipt must never resume automatic drain.
      const retained = queued ? restoreRejected(payload) : undefined;
      let settled = false;
      const onDelivery: NonNullable<SendMessageOptions['onDelivery']> = (status) => {
        if (status === 'uncertain' || settled) return;
        settled = true;
        if (sendPending.current === pending) sendPending.current = null;
        if (queued) {
          if (status === 'accepted' && retained) removeSubmitted(retained);
          return;
        }
        const savedRevisionConsumed =
          status === 'accepted' && submittedSavedDraft
            ? consumeChatDraft(submittedSavedDraft)
            : true;
        if (status === 'accepted' && !savedRevisionConsumed) return;
        const latest = latestDraft.current;
        const assigned =
          latest.composerGeneration === submitted.composerGeneration &&
          pending.assignedSessionId !== undefined &&
          pending.assignedSessionId === latest.sessionId &&
          latest.scope === submitted.scope + 1;
        if (!mounted.current || (latest.scope !== submitted.scope && !assigned)) return;
        if (latest.revision !== submitted.revision + (assigned ? 1 : 0)) {
          if (status === 'failed') restoreRejected(payload);
        } else if (status === 'accepted') {
          clearDraft();
          setImages([]);
          if (!useExternal) setContextBlocks([]);
        }
      };
      const sent = onSend(
        payload.text,
        payload.images.length ? payload.images : undefined,
        payload.contextBlocks.length ? payload.contextBlocks : undefined,
        onDelivery,
        (assignedSessionId) => {
          if (
            mounted.current &&
            sendPending.current === pending &&
            latestDraft.current.scope === submitted.scope
          ) {
            pending.assignedSessionId = assignedSessionId;
            if (draftStorageKey === undefined)
              assignedDraft.current = {
                composerGeneration: submitted.composerGeneration,
                assignment: {
                  fromSessionId: submitted.sessionId,
                  toSessionId: assignedSessionId,
                },
              };
          }
        },
      );
      if (!sent) onDelivery('failed');
      return sent;
    },
    [
      onSend,
      restoreRejected,
      removeSubmitted,
      clearDraft,
      useExternal,
      draftStorageKey,
      savedChatDraft,
      boundedFirstCommand,
      sendDisabledReason,
    ],
  );

  // Auto-send next queued message when agent finishes its turn
  useEffect(() => {
    if (
      prevRunning.current.running &&
      !running &&
      !sendPending.current &&
      !interruptPending.current &&
      !previewOpen &&
      !boundedFirstCommand &&
      !sendDisabledReason &&
      queuedMessages.length > 0
    ) {
      const q = dequeue();
      if (q) {
        sendOrdinary(q, true);
      }
    }
    // Keep a completed turn pending while the editor is modal. Its already
    // queued message may drain once editing closes, without sending this draft.
    if (!previewOpen || running) prevRunning.current.running = running;
  }, [
    running,
    queuedMessages,
    sendOrdinary,
    dequeue,
    previewOpen,
    boundedFirstCommand,
    sendDisabledReason,
  ]);

  // Show/hide slash picker based on input
  // TODO: Verify picker reopens correctly on backspace after space (e.g. "/simplify " → "/simplify")
  useEffect(() => {
    if (boundedFirstCommand) {
      setShowSlashPicker(false);
      return;
    }
    const trimmed = text.trimStart();
    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      setShowSlashPicker(true);
    } else if (!trimmed.startsWith('/')) {
      setShowSlashPicker(false);
    }
  }, [text, boundedFirstCommand]);

  function handleSlashSelect(name: string) {
    setText((draft) => `/${name} ${draft.trimStart().startsWith('/') ? '' : draft}`);
    setShowSlashPicker(false);
    textareaRef.current?.focus();
  }

  function handleSend() {
    if (
      previewOpen ||
      sendGuard.current ||
      sendPending.current ||
      interruptPending.current ||
      sendDisabledReason
    )
      return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    sendGuard.current = true;
    if (draftStorageKey !== undefined) flushDraft();
    const sent = sendOrdinary({
      text: trimmed || 'What do you see in this image?',
      images: [...images],
      contextBlocks: [...activeContextBlocks],
    });
    if (sent) {
      impactMedium();
      autoResize();
      textareaRef.current?.focus();
    }
    requestAnimationFrame(() => {
      sendGuard.current = false;
    });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (previewOpen) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (running && onInterrupt) {
        handleInterrupt();
      } else {
        handleSend();
      }
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;

    const remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    const toProcess = Array.from(files).slice(0, remaining);
    const ownerScope = latestDraft.current.scope;

    for (const file of toProcess) {
      try {
        if (!mounted.current || latestDraft.current.scope !== ownerScope) return;
        const attachment = await resizeImage(file);
        if (!mounted.current || latestDraft.current.scope !== ownerScope) return;
        setImages((prev) =>
          mounted.current &&
          latestDraft.current.scope === ownerScope &&
          prev.length < MAX_IMAGE_ATTACHMENTS
            ? [...prev, attachment]
            : prev,
        );
      } catch {
        // Image resize failed — skip this attachment silently
      }
    }

    if (mounted.current && latestDraft.current.scope === ownerScope && fileInputRef.current)
      fileInputRef.current.value = '';
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    if (remaining <= 0) return;

    const files = extractImageFiles(e.clipboardData.items, remaining);
    if (files.length === 0) return;

    e.preventDefault();
    const ownerScope = latestDraft.current.scope;
    for (const file of files) {
      try {
        if (!mounted.current || latestDraft.current.scope !== ownerScope) return;
        const attachment = await resizeImage(file);
        if (!mounted.current || latestDraft.current.scope !== ownerScope) return;
        setImages((prev) =>
          mounted.current &&
          latestDraft.current.scope === ownerScope &&
          prev.length < MAX_IMAGE_ATTACHMENTS
            ? [...prev, attachment]
            : prev,
        );
      } catch {
        // Image resize failed — skip silently
      }
    }
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  function previewImage(image: ImageAttachment) {
    setPreview({ image, sessionId, composerGeneration, draftStorageKey });
  }

  function savePreview(updated: ImageAttachment) {
    const selected = preview;
    const scope = previewScope.current;
    if (
      !selected ||
      previewRef.current !== selected ||
      selected.sessionId !== scope.sessionId ||
      selected.composerGeneration !== scope.composerGeneration ||
      selected.draftStorageKey !== scope.draftStorageKey ||
      !latestDraft.current.images.includes(selected.image)
    )
      return;
    imageKeys.current.set(updated, imageKey(selected.image));
    setImages((draft) => draft.map((image) => (image === selected.image ? updated : image)));
    setPreview(null);
  }

  function imageKey(image: ImageAttachment) {
    let key = imageKeys.current.get(image);
    if (key === undefined) {
      key = nextImageKey.current++;
      imageKeys.current.set(image, key);
    }
    return key;
  }

  const canSend = text.trim() || images.length > 0;

  const micProps = voice
    ? {
        available: voice.available,
        recording: voice.recording,
        transcribing: voice.transcribing,
        micBlocked: voice.micBlocked,
        onRecordStart: () => {
          if (!mounted.current || latestDraft.current.scope !== composerScope) return;
          voiceOperation.current = { scope: composerScope };
          voice.stopSpeaking();
          return voice.startRecording();
        },
        onRecordStop: async () => {
          if (!mounted.current || latestDraft.current.scope !== composerScope) return;
          const operation = { scope: composerScope };
          voiceOperation.current = operation;
          const transcript = await voice.stopRecording();
          const ownsTranscript = () =>
            mounted.current &&
            latestDraft.current.scope === composerScope &&
            voiceOperation.current === operation;
          if (transcript && ownsTranscript()) {
            setText((prev) =>
              ownsTranscript() ? (prev ? `${prev} ${transcript}` : transcript) : prev,
            );
            textareaRef.current?.focus();
          }
        },
        onRecordCancel: () => {
          if (!mounted.current || latestDraft.current.scope !== composerScope) return;
          voiceOperation.current = null;
          voice.cancelRecording();
        },
      }
    : null;

  function handleQueue() {
    if (
      boundedFirstCommand ||
      sendDisabledReason ||
      previewOpen ||
      sendPending.current ||
      interruptPending.current
    )
      return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const added = enqueue({
      text: trimmed || 'What do you see in this image?',
      images: [...images],
      contextBlocks: [...activeContextBlocks],
    });
    if (!added) return;
    impactMedium();
    setText('');
    setImages([]);
    if (!useExternal) setContextBlocks([]);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  function editQueuedMessage(index: number) {
    const q = editQueued(index);
    if (!q) return;
    setText(q.text);
    setImages(q.images);
    if (!useExternal) setContextBlocks(q.contextBlocks);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  function fireQueuedAsInterrupt(index: number) {
    if (boundedFirstCommand || sendDisabledReason || previewOpen) return;
    const q = queuedMessages[index];
    if (!q || sendPending.current || interruptPending.current || sendDisabledReason) return;
    if (!running) {
      removeQueued(index);
      sendOrdinary(q, true);
      return;
    }
    if (!onInterrupt) return;
    const pending = {};
    interruptPending.current = pending;
    removeQueued(index);
    const retained = restoreRejected(q);
    let settled = false;
    onInterrupt(
      q.text,
      q.images.length > 0 ? q.images : undefined,
      q.contextBlocks.length > 0 ? q.contextBlocks : undefined,
      (status) => {
        if (status === 'uncertain' || settled) return;
        settled = true;
        if (interruptPending.current === pending) interruptPending.current = null;
        if (status === 'accepted') removeSubmitted(retained);
      },
    );
  }

  function handleInterrupt() {
    if (
      boundedFirstCommand ||
      previewOpen ||
      sendGuard.current ||
      sendPending.current ||
      interruptPending.current ||
      sendDisabledReason ||
      !onInterrupt
    )
      return;
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    sendGuard.current = true;
    const pending = {};
    interruptPending.current = pending;
    const submitted = latestDraft.current;
    onInterrupt(
      trimmed || 'What do you see in this image?',
      images.length > 0 ? images : undefined,
      activeContextBlocks.length > 0 ? activeContextBlocks : undefined,
      (status) => {
        if (status === 'uncertain') return;
        if (interruptPending.current === pending) interruptPending.current = null;
        if (!mounted.current || latestDraft.current.scope !== submitted.scope) return;
        if (latestDraft.current.revision !== submitted.revision) {
          if (status === 'failed')
            restoreRejected({ ...submitted, text: trimmed || 'What do you see in this image?' });
          return;
        }
        if (status === 'accepted') {
          clearDraft();
          setImages([]);
          if (!useExternal) setContextBlocks([]);
        }
      },
    );
    // Local transport acceptance cannot confirm an interrupt. Keep its exact input
    // until an authoritative receipt, and protect edits made while it is pending.
    requestAnimationFrame(() => {
      sendGuard.current = false;
    });
    autoResize();
    textareaRef.current?.focus();
  }

  return (
    <div className="chat-input chat-input--compact">
      {savedChatDraft && (
        <p className="chat-draft-save-status" role={saveFailed ? 'alert' : 'status'}>
          {saveFailed
            ? 'Couldn’t save this draft on this device. Keep it open and free some storage before leaving.'
            : 'Saved to Drafts · message and settings stay editable'}
        </p>
      )}
      {images.length > 0 && (
        <div className="chat-input-previews">
          {images.map((image, index) => (
            <div key={imageKey(image)} className="chat-input-preview">
              <button
                type="button"
                className="chat-input-preview-open"
                aria-label={`Preview attachment ${index + 1}`}
                onClick={(event) => {
                  event.currentTarget.focus();
                  previewImage(image);
                }}
              >
                <img src={image.preview} alt={`Attachment ${index + 1}`} />
              </button>
              <button
                type="button"
                className="chat-input-preview-remove"
                aria-label={`Remove attachment ${index + 1}`}
                onClick={() => removeImage(index)}
              >
                <UiIcon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {previewOpen && preview && (
        <ImageAttachmentEditor
          key={imageKey(preview.image)}
          image={preview.image}
          onSave={savePreview}
          onClose={() => setPreview(null)}
        />
      )}
      <MotionPresence open={showSlashPicker} kind="popover" appear={false}>
        <SlashPicker
          query={text.trimStart()}
          onSelect={handleSlashSelect}
          onClose={() => setShowSlashPicker(false)}
          cwd={cwd}
        />
      </MotionPresence>
      {voice?.recording && voice.partialTranscript && (
        <div className="voice-partial">{voice.partialTranscript}</div>
      )}
      {queuedMessages.map((q, i) => (
        <div key={i} className="chat-input-queued">
          <span className="chat-input-queued-label">{i + 1}</span>
          <span className="chat-input-queued-text">{q.text}</span>
          {onInterrupt && !boundedFirstCommand && (
            <button
              className="chat-input-queued-btn chat-input-queued-btn--fire"
              disabled={!!sendDisabledReason}
              onClick={() => fireQueuedAsInterrupt(i)}
              title={running ? 'Send now (interrupt)' : 'Send now'}
            >
              Send Now
            </button>
          )}
          <button className="chat-input-queued-btn" onClick={() => editQueuedMessage(i)}>
            Edit
          </button>
          <button
            className="chat-input-queued-btn chat-input-queued-btn--clear"
            onClick={() => removeQueued(i)}
            aria-label={`Remove queued message ${i + 1}`}
          >
            <UiIcon name="close" size={16} />
          </button>
        </div>
      ))}
      {sendDisabledReason && <span role="status">{sendDisabledReason}</span>}
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input-field"
          aria-label="Message Mitzo"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={running ? 'Type to queue or interrupt...' : 'Message Mitzo...'}
          rows={1}
        />
        <div className="composer-toolbar">
          <div
            className="chat-input-command-strip"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, a, select')) {
                e.preventDefault();
              }
            }}
          >
            <ComposerTools
              terminalHref={
                sessionId && !boundedFirstCommand
                  ? `/terminal?sessionId=${encodeURIComponent(sessionId)}&returnTo=${encodeURIComponent(`/chat/${sessionId}`)}`
                  : undefined
              }
              onCommands={() => {
                if (!text.trim()) setText('/');
                setShowSlashPicker(true);
                textareaRef.current?.focus();
              }}
              commandsExpanded={showSlashPicker}
              commandsDisabled={boundedFirstCommand}
              onAttach={() => fileInputRef.current?.click()}
              attachmentDisabled={images.length >= MAX_IMAGE_ATTACHMENTS}
              onDismiss={() => textareaRef.current?.focus()}
              isolation={isolation}
              onIsolationChange={onIsolationChange}
              branch={branch}
              isWorktree={isWorktree}
              wtId={wtId}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              capture="environment"
              onChange={handleFileChange}
              className="sr-only"
            />
            {!useExternal && (
              <SessionTray
                placement="toolbar"
                contextRemovalOnly={boundedFirstCommand}
                messages={messages}
                current={current}
                bootContext={bootContext}
                sessionContext={sessionContext}
                selectedContextBlocks={contextBlocks}
                draftImages={images}
                onToggleContextBlock={(name) =>
                  setContextBlocks((prev) =>
                    prev.includes(name) ? prev.filter((value) => value !== name) : [...prev, name],
                  )
                }
                onAddImages={() => fileInputRef.current?.click()}
                onRemoveImage={removeImage}
                onPreviewImage={previewImage}
                getDraftImageKey={imageKey}
              />
            )}
          </div>
          <div className="composer-actions">
            {tokenState && <TokenBar tokenState={tokenState} />}
            {micProps && <MicButton {...micProps} />}
            {running ? (
              <>
                {canSend && onInterrupt && !boundedFirstCommand && (
                  <button
                    className="chat-input-btn chat-input-btn--interrupt"
                    aria-label="Interrupt and send now"
                    disabled={!!sendDisabledReason}
                    onClick={handleInterrupt}
                    title="Interrupt — send now, mid-thinking"
                  >
                    <UiIcon name="interrupt" />
                  </button>
                )}
                {canSend && !boundedFirstCommand && (
                  <button
                    className="chat-input-btn chat-input-btn--queue"
                    aria-label="Queue message"
                    disabled={!!sendDisabledReason}
                    onClick={handleQueue}
                    title="Queue — send after current turn"
                  >
                    <UiIcon name="send" />
                  </button>
                )}
                <button
                  className="chat-input-btn chat-input-btn--stop"
                  onClick={onStop}
                  aria-label="Stop generation"
                  title="Stop generation"
                >
                  <UiIcon name="stop" />
                </button>
              </>
            ) : (
              <button
                className="chat-input-btn chat-input-btn--send"
                onClick={handleSend}
                aria-label="Send message"
                disabled={!canSend || !!sendDisabledReason}
              >
                <UiIcon name="send" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
