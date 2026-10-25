import { ChatStatusMessage, type ChatStatusAction } from './ChatStatusMessage';
import { MotionPresence } from './MotionPresence';
import { ComposerResponders, type ComposerResponderSelection } from './ComposerResponders';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useImperativeHandle,
  type RefObject,
  type ReactNode,
  type KeyboardEvent,
  type ChangeEvent,
  type SetStateAction,
} from 'react';
import type { BootContextMeta, SendMessageOptions } from '@mitzo/client';
import type { FinishedMessage, ImageAttachment, StreamingMessage } from '../types/chat';
import { resizeImage } from '../lib/resizeImage';
import { extractImageFiles } from '../lib/paste-images';
import { MAX_IMAGE_ATTACHMENTS } from '../lib/constants';
import { SlashPicker } from './SlashPicker';
import { SessionResourcesDialog } from './SessionResourcesDialog';
import { ImageAttachmentEditor } from './ImageAttachmentEditor';
import { ComposerTools } from './ComposerTools';
import { UiIcon } from './UiIcon';
import { MicButton } from './MicButton';
import { impactMedium } from '../lib/haptics';
import { TokenBar } from './TokenBar';
import { insertComposerCommand } from '../lib/composer-command';
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

function attachmentPrompt(text: string, images: ImageAttachment[]): string {
  const pages = images.flatMap((image, index) =>
    image.name ? [`Attachment ${index + 1}: ${image.name.replace(/[\r\n]/g, ' ')}`] : [],
  );
  const prompt =
    text || (pages.length ? 'Please read the attached PDF.' : 'What do you see in this image?');
  return pages.length
    ? `${prompt}\n\nPDF pages are attached as images in this order:\n${pages.join('\n')}`
    : prompt;
}

export interface ChatInputDraftControl {
  storageKey: string | undefined;
  clear: () => void;
  /** Read the current edited text without waiting for debounced persistence. */
  readText?: () => string;
  flush?: () => boolean;
}

interface Props {
  responders?: ComposerResponderSelection;
  /** A retained delivery route may support text and voice but no attachments. */
  textOnly?: boolean;
  settings?: ReactNode;
  sendLabel?: string;
  onSend: (
    text: string,
    images?: ImageAttachment[],
    contextBlocks?: string[],
    onDelivery?: SendMessageOptions['onDelivery'],
    onSessionAssigned?: SendMessageOptions['onSessionAssigned'],
    composerDraft?: SendMessageOptions['composerDraft'],
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
  /** Supplied only after the exact command's authenticated consumed receipt. */
  acceptedComposerDraft?: SendMessageOptions['composerDraft'];
  draftControl?: RefObject<ChatInputDraftControl | null>;
  sendDisabledReason?: string;
  sendDisabledAction?: ChatStatusAction;
  boundedFirstCommand?: boolean;
  /** Admit queued commands immediately with frozen settings through the owning runtime. */
  guardedConversation?: boolean;
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
  onExternalContextBlockToggle?: (name: string) => void;
  tokenState?: TokenState;
  collaboration?: ReactNode;
  compactions?: import('@mitzo/protocol').ContextCompaction[];
  compactionError?: string;
  compactionTruncated?: boolean;
  messages?: FinishedMessage[];
  current?: StreamingMessage | null;
  bootContext?: BootContextMeta | null;
  sessionContext?: string | null;
}

const EMPTY_MESSAGES: FinishedMessage[] = [];

export function ChatInput({
  responders,
  textOnly = false,
  settings,
  sendLabel = 'Send message',
  onSend,
  onStop,
  onInterrupt,
  running,
  initialText,
  draftStorageKey: suppliedDraftStorageKey,
  savedChatDraft,
  acceptedComposerDraft,
  draftControl,
  sendDisabledReason: suppliedSendDisabledReason,
  sendDisabledAction,
  boundedFirstCommand = false,
  guardedConversation = false,
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
  onExternalContextBlockToggle,
  tokenState,
  collaboration,
  compactions,
  compactionError,
  compactionTruncated,
  messages = EMPTY_MESSAGES,
  current,
  bootContext,
  sessionContext,
}: Props) {
  const draftStorageKey = savedChatDraft
    ? chatDraftStorageKey(savedChatDraft.id)
    : suppliedDraftStorageKey;
  const sendPending = useRef<{ assignedSessionId?: string } | null>(null);
  const [pendingText, setPendingText] = useState<{
    pending: object;
    scope: number;
    textRevision: number;
    composerGeneration: number;
  } | null>(null);
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
  const [text, setText, clearDraft, flushDraft, draftReceipt] = useDraft(
    sessionId,
    initialText ?? savedChatDraft?.text,
    draftStorageKey,
    assignment,
  );

  const [images, setImages] = useState<ImageAttachment[]>(savedChatDraft?.images ?? []);
  const [attachmentImport, setAttachmentImport] = useState<{
    scope: number;
    error?: string;
    busy: boolean;
  } | null>(null);
  const importPending = useRef<{ scope: number } | null>(null);
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
  const [respondersOpen, setRespondersOpen] = useState(false);
  const activeContextBlocks = useExternal ? externalContextBlocks : contextBlocks;
  const previousSavedId = useRef(savedChatDraft?.id);
  const savedOwnerChanging = previousSavedId.current !== savedChatDraft?.id;
  useLayoutEffect(() => {
    if (!savedOwnerChanging) return;
    previousSavedId.current = savedChatDraft?.id;
    setImages(savedChatDraft?.images ?? []);
    if (!useExternal) setContextBlocks(savedChatDraft?.contextBlocks ?? []);
  }, [savedChatDraft, savedOwnerChanging, useExternal]);
  const { capture: captureDraft, consume: consumeDraftReceipt, revise: reviseDraft } = draftReceipt;
  const consumedRevision = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const revision = draftReceipt.consumedRevision;
    if (!revision || consumedRevision.current === revision) return;
    consumedRevision.current = revision;
    setImages([]);
    if (!useExternal) setContextBlocks([]);
  }, [draftReceipt.consumedRevision, useExternal]);
  const settingsSignature = JSON.stringify(savedChatDraft?.settings);
  const attachmentRevision = useRef({
    images,
    contextBlocks: activeContextBlocks,
    settingsSignature,
  });
  useLayoutEffect(() => {
    const previous = attachmentRevision.current;
    if (
      previous.images !== images ||
      previous.contextBlocks !== activeContextBlocks ||
      previous.settingsSignature !== settingsSignature
    )
      reviseDraft();
    attachmentRevision.current = { images, contextBlocks: activeContextBlocks, settingsSignature };
  }, [images, activeContextBlocks, settingsSignature, reviseDraft]);
  useLayoutEffect(() => {
    // This also handles a verified receipt arriving before the composer mounts.
    // Durable revision equality protects edits from earlier mounts and other tabs.
    if (!acceptedComposerDraft || !consumeDraftReceipt(acceptedComposerDraft)) return;
    setImages([]);
    if (!useExternal) setContextBlocks([]);
  }, [acceptedComposerDraft, consumeDraftReceipt, useExternal]);
  useImperativeHandle(
    draftControl,
    () => ({
      storageKey: draftStorageKey,
      clear: clearDraft,
      readText: () => text,
      flush: () => {
        flushDraft();
        if (!savedChatDraft) return true;
        const current = getChatDraft(savedChatDraft.id) ?? savedChatDraft;
        return saveChatDraft({
          ...current,
          settings: savedChatDraft.settings,
          text,
          images,
          contextBlocks: activeContextBlocks,
        });
      },
    }),
    [draftStorageKey, clearDraft, text, flushDraft, savedChatDraft, images, activeContextBlocks],
  );
  const selectedResponderIds =
    responders?.responders?.kind === 'selected'
      ? responders.responders.sessionIds
      : (responders?.selectedIds ?? []);
  const sendDisabledReason =
    suppliedSendDisabledReason ??
    (respondersOpen ? 'Choose who replies, or close the picker to keep your draft.' : undefined) ??
    (responders?.responders?.kind === 'selected' && !responders.responders.sessionIds.length
      ? 'Use @ to choose who replies before sending.'
      : undefined) ??
    (responders &&
    selectedResponderIds.some(
      (id) => !responders.members.some((m) => m.id === id && !m.unavailableReason),
    )
      ? 'A selected agent is unavailable. Choose who replies before sending.'
      : undefined) ??
    (textOnly && (images.length || activeContextBlocks.length)
      ? 'Remove attachments and context before sending through this conversation’s text-only route.'
      : undefined) ??
    ((boundedFirstCommand || guardedConversation) && activeContextBlocks.length
      ? boundedFirstCommand
        ? 'Remove attached context before sending the Local command.'
        : 'Remove attached context before sending this conversation command.'
      : undefined) ??
    validateSend?.(
      text.trim() || 'What do you see in this image?',
      images.length ? images : undefined,
    );
  const [saveResult, setSaveResult] = useState<{
    draft: ChatDraft;
    failed: boolean;
    stored: boolean;
  } | null>(null);
  // Keep the save acknowledgement and composer geometry settled before paint.
  useLayoutEffect(() => {
    if (!savedChatDraft || savedOwnerChanging) return;
    const current = getChatDraft(savedChatDraft.id) ?? savedChatDraft;
    const draft = {
      ...current,
      settings: savedChatDraft.settings,
      text,
      images,
      contextBlocks: activeContextBlocks,
    };
    const saved = saveChatDraft(draft);
    setSaveResult({ draft, failed: !saved, stored: saved && getChatDraft(draft.id) !== null });
  }, [savedChatDraft, savedOwnerChanging, text, images, activeContextBlocks]);
  // A prior revision's successful write cannot confirm current edits or a new owner.
  const currentSave =
    savedChatDraft &&
    !savedOwnerChanging &&
    saveResult?.draft.id === savedChatDraft.id &&
    saveResult.draft.settings === savedChatDraft.settings &&
    saveResult.draft.text === text &&
    saveResult.draft.images === images &&
    saveResult.draft.contextBlocks === activeContextBlocks
      ? saveResult
      : null;
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
    textRevision: 0,
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
    textRevision: previous.textRevision + (previous.text !== text || scopeChanged ? 1 : 0),
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
  const pendingAssignment =
    pendingText !== null &&
    pendingText.composerGeneration === composerGeneration &&
    sendPending.current?.assignedSessionId !== undefined &&
    sendPending.current.assignedSessionId === sessionId &&
    composerScope === pendingText.scope + 1;
  // The outbox already owns the visible user message. Retain this exact draft
  // for receipt recovery without leaving its submitted text in the input.
  const hideSubmittedText =
    pendingText !== null &&
    sendPending.current === pendingText.pending &&
    (composerScope === pendingText.scope || pendingAssignment) &&
    latestDraft.current.textRevision === pendingText.textRevision + (pendingAssignment ? 1 : 0);
  const displayedText = hideSubmittedText ? '' : text;
  const displayedDraft = useRef<{ pending?: object; text: string }>({ text });
  displayedDraft.current = { pending: hideSubmittedText ? pendingText.pending : undefined, text };
  const editText = useCallback(
    (update: SetStateAction<string>) => {
      const pending = displayedDraft.current.pending;
      const submittedText = displayedDraft.current.text;
      const editingSubmitted = pending !== undefined && pending === sendPending.current;
      if (editingSubmitted) {
        displayedDraft.current.pending = undefined;
        setPendingText(null);
        // Pasting an identical next message is still a new draft revision.
        latestDraft.current = {
          ...latestDraft.current,
          revision: latestDraft.current.revision + 1,
          textRevision: latestDraft.current.textRevision + 1,
        };
      }
      setText((previous) =>
        typeof update === 'function'
          ? update(editingSubmitted && submittedText === previous ? '' : previous)
          : update,
      );
    },
    [setText],
  );
  const importing = attachmentImport?.scope === composerScope && attachmentImport.busy;
  const attachmentError =
    attachmentImport?.scope === composerScope ? attachmentImport.error : undefined;
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
    if (
      !window.matchMedia?.('(max-width: 767px), (pointer: coarse)').matches &&
      document.activeElement === document.body
    )
      textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (initialText && !initialApplied.current) {
      initialApplied.current = true;
      requestAnimationFrame(() => {
        autoResize();
        if (!window.matchMedia?.('(max-width: 767px), (pointer: coarse)').matches)
          textareaRef.current?.focus();
      });
    }
  }, [initialText, autoResize]);

  // A passive resize can paint the new text at the previous draft’s height.
  useLayoutEffect(() => {
    autoResize();
  }, [displayedText, autoResize]);

  const sendOrdinary = useCallback(
    (
      payload: { text: string; images: ImageAttachment[]; contextBlocks: string[] },
      queued = false,
    ): boolean => {
      if (queued && (boundedFirstCommand || sendDisabledReason)) return false;
      const submitted = latestDraft.current;
      const submittedSavedDraft = savedChatDraft ? getChatDraft(savedChatDraft.id) : null;
      const composerDraft = queued ? undefined : captureDraft();
      const pending: { assignedSessionId?: string } = {};
      sendPending.current = pending;
      if (!queued)
        setPendingText({
          pending,
          scope: submitted.scope,
          textRevision: submitted.textRevision,
          composerGeneration: submitted.composerGeneration,
        });
      // Keep dequeued input under the existing explicit-retry fence until a
      // definitive receipt. A missing receipt must never resume automatic drain.
      const retained = queued ? restoreRejected(payload) : undefined;
      let settled = false;
      const onDelivery: NonNullable<SendMessageOptions['onDelivery']> = (status) => {
        if (settled) return;
        if (displayedDraft.current.pending === pending) displayedDraft.current.pending = undefined;
        if (mounted.current)
          setPendingText((current) => (current?.pending === pending ? null : current));
        if (status === 'uncertain') return;
        settled = true;
        if (sendPending.current === pending) sendPending.current = null;
        if (queued) {
          if (status === 'accepted' && retained) removeSubmitted(retained);
          return;
        }
        const latest = latestDraft.current;
        const assigned =
          latest.composerGeneration === submitted.composerGeneration &&
          pending.assignedSessionId !== undefined &&
          pending.assignedSessionId === latest.sessionId &&
          latest.scope === submitted.scope + 1;
        const ownsDraft = latest.scope === submitted.scope || assigned;
        const draftEdited = latest.revision !== submitted.revision + (assigned ? 1 : 0);
        const textEdited = latest.textRevision !== submitted.textRevision + (assigned ? 1 : 0);
        if (status === 'accepted' && submittedSavedDraft && ownsDraft && draftEdited) {
          // Attachment/context edits belong to the next draft. Consume only the
          // accepted text, retaining those edits and any newer text verbatim.
          if (mounted.current && !textEdited) setText('');
          return;
        }
        const savedRevisionConsumed =
          status === 'accepted' && submittedSavedDraft
            ? consumeChatDraft(submittedSavedDraft)
            : true;
        if (status === 'accepted' && !savedRevisionConsumed) return;
        if (!mounted.current || !ownsDraft) return;
        if (draftEdited) {
          if (status === 'failed') restoreRejected(payload);
          else if (!textEdited) clearDraft();
        } else if (status === 'accepted') {
          clearDraft();
          setImages([]);
          if (!useExternal) setContextBlocks([]);
        }
      };
      const sent = onSend(
        attachmentPrompt(payload.text, payload.images),
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
        composerDraft,
      );
      if (!sent) onDelivery('failed');
      return sent;
    },
    [
      onSend,
      restoreRejected,
      removeSubmitted,
      clearDraft,
      setText,
      useExternal,
      draftStorageKey,
      savedChatDraft,
      captureDraft,
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
      !guardedConversation &&
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
    guardedConversation,
    sendDisabledReason,
  ]);

  // Show/hide slash picker based on input
  // TODO: Verify picker reopens correctly on backspace after space (e.g. "/simplify " → "/simplify")
  useEffect(() => {
    if (boundedFirstCommand || guardedConversation) {
      setShowSlashPicker(false);
      return;
    }
    const trimmed = displayedText.trimStart();
    if (trimmed.startsWith('/') && !/\s/.test(trimmed)) {
      setShowSlashPicker(true);
    } else {
      setShowSlashPicker(false);
    }
  }, [displayedText, boundedFirstCommand, guardedConversation]);

  function handleSlashSelect(name: string) {
    editText((draft) => insertComposerCommand(draft, name));
    setShowSlashPicker(false);
    textareaRef.current?.focus();
  }

  function handleSend() {
    if (importPending.current?.scope === composerScope) return;
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
      text:
        trimmed ||
        (images.some((image) => image.name)
          ? 'Please read the attached PDF.'
          : 'What do you see in this image?'),
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
    if (respondersOpen && ['ArrowDown', 'Enter', 'Escape'].includes(e.key) && !e.shiftKey) {
      e.preventDefault();
      const panel = textareaRef.current
        ?.closest('.chat-input')
        ?.querySelector<HTMLElement>('.composer-responder-picker');
      if (e.key === 'Escape') panel?.querySelector<HTMLButtonElement>('button:last-child')?.click();
      else {
        const choice = panel?.querySelector<HTMLInputElement | HTMLButtonElement>(
          '[data-responder-choice]:not(:disabled)',
        );
        if (e.key === 'Enter') choice?.click();
        else choice?.focus();
      }
      return;
    }
    if (previewOpen) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (showSlashPicker && ['Enter', 'ArrowDown', 'Escape'].includes(e.key) && !e.shiftKey) {
      e.preventDefault();
      if (e.key === 'Escape') setShowSlashPicker(false);
      else {
        const choice = textareaRef.current
          ?.closest('.chat-input')
          ?.querySelector<HTMLButtonElement>('.slash-picker-item');
        if (e.key === 'Enter') choice?.click();
        else choice?.focus();
      }
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

  async function importFiles(files: File[]) {
    if (textOnly || importPending.current?.scope === composerScope) return;
    const operation = { scope: composerScope };
    importPending.current = operation;
    setAttachmentImport({ scope: composerScope, busy: true });
    const isCurrent = () =>
      mounted.current &&
      latestDraft.current.scope === operation.scope &&
      importPending.current === operation;
    let remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    try {
      for (const file of files) {
        if (!isCurrent()) return;
        if (remaining <= 0)
          throw new Error(
            `Up to ${MAX_IMAGE_ATTACHMENTS} images or PDF pages can be attached per message.`,
          );
        const attachments =
          file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
            ? await (await import('../lib/pdf-to-images')).pdfToImages(file, remaining)
            : [await resizeImage(file)];
        if (!isCurrent()) return;
        remaining -= attachments.length;
        setImages((prev) =>
          mounted.current && latestDraft.current.scope === operation.scope
            ? [...prev, ...attachments]
            : prev,
        );
      }
    } catch (error: unknown) {
      if (isCurrent())
        setAttachmentImport({
          scope: operation.scope,
          busy: false,
          error: error instanceof Error ? error.message : 'Could not import the attachment.',
        });
    } finally {
      if (isCurrent()) {
        importPending.current = null;
        setAttachmentImport((state) =>
          state?.scope === operation.scope ? { ...state, busy: false } : state,
        );
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  }

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) await importFiles(Array.from(e.target.files));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    if (textOnly) return;
    const remaining = MAX_IMAGE_ATTACHMENTS - images.length;
    if (remaining <= 0) return;
    const files = extractImageFiles(e.clipboardData.items, remaining);
    if (!files.length) return;
    e.preventDefault();
    await importFiles(files);
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
    if (selected.image.name) updated = { ...updated, name: selected.image.name };
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

  const canSend = displayedText.trim() || images.length > 0;

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
            editText((prev) =>
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
    if (importPending.current?.scope === composerScope) return;
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
    if (guardedConversation) {
      sendOrdinary({
        text:
          trimmed ||
          (images.some((image) => image.name)
            ? 'Please read the attached PDF.'
            : 'What do you see in this image?'),
        images: [...images],
        contextBlocks: [],
      });
      return;
    }
    const added = enqueue({
      text:
        trimmed ||
        (images.some((image) => image.name)
          ? 'Please read the attached PDF.'
          : 'What do you see in this image?'),
      images: [...images],
      contextBlocks: [...activeContextBlocks],
    });
    if (!added) return;
    impactMedium();
    editText('');
    setImages([]);
    if (!useExternal) setContextBlocks([]);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  function editQueuedMessage(index: number) {
    if (importPending.current?.scope === composerScope) return;
    const q = editQueued(index);
    if (!q) return;
    editText(q.text);
    setImages(q.images);
    if (!useExternal) setContextBlocks(q.contextBlocks);
    requestAnimationFrame(() => {
      autoResize();
      textareaRef.current?.focus();
    });
  }

  function fireQueuedAsInterrupt(index: number) {
    if (boundedFirstCommand || guardedConversation || sendDisabledReason || previewOpen) return;
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
      attachmentPrompt(q.text, q.images),
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
    if (importPending.current?.scope === composerScope) return;
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
      attachmentPrompt(trimmed, images),
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
      {currentSave && (currentSave.failed || (currentSave.stored && !hideSubmittedText)) && (
        <p className="chat-draft-save-status" role={currentSave.failed ? 'alert' : 'status'}>
          {currentSave.failed
            ? 'Couldn’t save this draft on this device. Keep it open and free some storage before leaving.'
            : 'Draft saved on this device'}
        </p>
      )}
      {attachmentError && (
        <p className="chat-draft-save-status" role="alert">
          {attachmentError}
        </p>
      )}
      {importing && (
        <p className="chat-draft-save-status" role="status">
          Importing attachment… PDFs become page images (up to {MAX_IMAGE_ATTACHMENTS} pages per
          message).
        </p>
      )}
      {images.length > 0 && (
        <div className="chat-input-previews">
          {images.map((image, index) => (
            <div key={imageKey(image)} className="chat-input-preview">
              <button
                type="button"
                className="chat-input-preview-open"
                aria-label={
                  image.name ? `Preview ${image.name}` : `Preview attachment ${index + 1}`
                }
                title={image.name}
                onClick={(event) => {
                  event.currentTarget.focus();
                  previewImage(image);
                }}
              >
                <img src={image.preview} alt={image.name ?? `Attachment ${index + 1}`} />
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
          query={displayedText.trimStart()}
          onSelect={handleSlashSelect}
          onClose={(reason) => {
            if (reason === 'escape') textareaRef.current?.focus();
            setShowSlashPicker(false);
          }}
          cwd={cwd}
        />
      </MotionPresence>
      {voice?.recording && voice.partialTranscript && (
        <div
          className="voice-partial"
          role="status"
          aria-live="polite"
          aria-label="Live transcription"
        >
          <em>{voice.partialTranscript}</em>
        </div>
      )}
      {queuedMessages.map((q, i) => (
        <div key={i} className="chat-input-queued">
          <span className="chat-input-queued-label">{i + 1}</span>
          <span className="chat-input-queued-text">{q.text}</span>
          {onInterrupt && !boundedFirstCommand && (
            <button
              className="chat-input-queued-btn chat-input-queued-btn--fire"
              disabled={!!sendDisabledReason || importing}
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
      <ChatStatusMessage status={sendDisabledReason} action={sendDisabledAction} />
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-input-field"
          aria-label="Message Mitzo"
          value={displayedText}
          aria-busy={hideSubmittedText || undefined}
          onChange={(e) => editText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            running
              ? 'Type to queue or interrupt...'
              : responders
                ? 'Message… @ to choose who replies'
                : 'Message Mitzo...'
          }
          rows={1}
        />
        {settings}
        <div className="composer-toolbar">
          <div
            className="chat-input-command-strip"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button, a, select')) {
                e.preventDefault();
              }
            }}
          >
            {responders && (
              <ComposerResponders
                selection={responders}
                text={displayedText}
                onTextChange={editText}
                input={textareaRef}
                onOpenChange={setRespondersOpen}
              />
            )}
            <ComposerTools
              terminalHref={
                sessionId && !boundedFirstCommand && !guardedConversation
                  ? `/terminal?sessionId=${encodeURIComponent(sessionId)}&returnTo=${encodeURIComponent(`/chat/${sessionId}`)}`
                  : undefined
              }
              onCommands={() => {
                if (!displayedText.trim()) editText('/');
                setShowSlashPicker(true);
                textareaRef.current?.focus();
              }}
              commandsExpanded={showSlashPicker}
              commandsDisabled={boundedFirstCommand || guardedConversation || textOnly}
              onAttach={() => fileInputRef.current?.click()}
              attachmentDisabled={textOnly || importing || images.length >= MAX_IMAGE_ATTACHMENTS}
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
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.pdf"
              multiple
              onChange={handleFileChange}
              className="sr-only"
            />
            {(!useExternal || onExternalContextBlockToggle) && (
              <SessionResourcesDialog
                sourceSnapshots={savedChatDraft?.settings.sourceSnapshots}
                sessionId={sessionId}
                compactions={compactions}
                compactionError={compactionError}
                compactionTruncated={compactionTruncated}
                placement="toolbar"
                contextRemovalOnly={boundedFirstCommand || guardedConversation}
                messages={messages}
                current={current}
                bootContext={bootContext}
                sessionContext={sessionContext}
                selectedContextBlocks={activeContextBlocks}
                draftImages={images}
                onToggleContextBlock={
                  onExternalContextBlockToggle ??
                  ((name) =>
                    setContextBlocks((prev) =>
                      prev.includes(name)
                        ? prev.filter((value) => value !== name)
                        : [...prev, name],
                    ))
                }
                onAddImages={() => fileInputRef.current?.click()}
                onRemoveImage={removeImage}
                onPreviewImage={previewImage}
                getDraftImageKey={imageKey}
              />
            )}
            {collaboration ?? (
              <button
                type="button"
                className="chat-input-btn"
                aria-label="Symposium collaboration"
                title="Start a supported chat to use Symposium collaboration"
                disabled
              >
                <UiIcon name="agents" />
              </button>
            )}
          </div>
          <div className="composer-actions">
            {tokenState && (
              <TokenBar
                tokenState={tokenState}
                alwaysVisible
                userTurns={messages.filter((message) => message.role === 'user').length}
              />
            )}
            {micProps && <MicButton {...micProps} />}
            {running ? (
              <>
                {canSend && onInterrupt && !boundedFirstCommand && (
                  <button
                    className="chat-input-btn chat-input-btn--interrupt"
                    aria-label="Interrupt and send now"
                    disabled={!!sendDisabledReason || importing}
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
                    disabled={!!sendDisabledReason || importing}
                    onClick={handleQueue}
                    title="Queue — send after current turn"
                  >
                    <UiIcon name="queue" />
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
                className={`chat-input-btn chat-input-btn--send${sendLabel === 'Start session' ? ' chat-input-btn--start' : ''}`}
                onClick={handleSend}
                aria-label={sendLabel}
                disabled={!canSend || !!sendDisabledReason || importing}
              >
                <UiIcon name="sendPrompt" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
