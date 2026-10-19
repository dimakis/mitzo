import { TelosAdvisorDraft } from '../components/TelosAdvisorDraft';
import { bindChatDraftToSession, getSessionChatDraft } from '../lib/chat-drafts';
import { TelosRoleSetup } from '../components/TelosRoleSetup';
import { readTelosRoleIntent } from '../hooks/useTelosRoleSetup';
import { AgentLibraryChatLink } from '../components/AgentLibraryChatSource';
import { markAgentBuilderAssigned } from '../lib/agent-builder-chat';
import { TelosSourceWorkLink } from '../components/TelosSourceWorkLink';
import { ConversationAgents } from '../components/ConversationAgents';
import { useCompactionHistory } from '../hooks/useCompactionHistory';
import { ChatWelcome } from '../components/ChatWelcome';
import {
  runtimeModelAccounts,
  preparedRuntimeModelEditable,
  selectedRuntimeRoute,
} from '../lib/chat-runtime-route';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import { AgentSettingsFields } from '../components/AgentSettingsPicker';
import { ChatExecutionPicker } from '../components/ChatExecutionPicker';
import {
  buildLocalFirstCommand,
  prepareLocalFirstCommand,
  prepareLocalContinuationCommand,
} from '../lib/explicit-local-chat';
import { createBrowserId } from '../lib/browser-crypto';
import { useNewChatDraft, useChatDraftSearch } from '../hooks/useNewChatDraft';
import {
  newChatPathWithDraft,
  CHAT_DRAFTS_CHANGED,
  getChatDraft,
  chatDraftStorageKey,
  chatDraftTextKey,
} from '../lib/chat-drafts';
import { useBriefingChat } from '../hooks/useBriefingChat';
import { BriefingChatBanner } from '../components/BriefingChatBanner';
import { ChatAgentProfilePicker } from '../components/ChatAgentProfilePicker';
import {
  PROFILE_BUILDER_ID,
  profileBuilderDefinitionForRevision,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import { UiIcon } from '../components/UiIcon';
import {
  savedRepositoryDraft,
  repositoryDraftKey,
  consumeRepositoryDraft,
  repositoryPromptDraftKey,
} from '../lib/repository-draft';
import {
  RepositoryChatPicker,
  type RepositoryChatSelection,
} from '../components/RepositoryChatPicker';
import { usePendingLaunch } from '../hooks/usePendingLaunch';
import {
  useRepositoryChatPreparation,
  repositoryChatSendDisabledReason,
} from '../hooks/useRepositoryChatPreparation';
import { RepositoryChatDraftNotice } from '../components/RepositoryChatDraftNotice';
import { SymposiumReviewEntry } from '../components/SymposiumReviewPanel';
import { AddAgentSheet } from '../components/AddReviewerSheet';
import { OrdinaryCollaborationEntry } from '../components/OrdinaryCollaborationEntry';
import { PermissionModePicker } from '../components/PermissionModePicker';
import { StatusBar } from '../components/StatusBar';
import { SessionAccess } from '../components/SessionAccess';
import { WorkspaceControls } from '../components/WorkspaceControls';
import type { WorkspaceSummary } from '../types/workspace';
import { CodexQueueStatus } from '../components/CodexQueueStatus';
import { WebSearchConsent } from '../components/WebSearchConsent';
import { AccountModelPicker, type AccountSelection } from '../components/AccountModelPicker';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { SymposiumConversation } from '../components/SymposiumConversation';
import { SymposiumDirectorPanel } from '../components/SymposiumDirectorPanel';
import { ChatInput, type ChatInputDraftControl } from '../components/ChatInput';
import { VoiceSettings } from '../components/VoiceSettings';
import { useMessages, useConnection, useTokens, useMitzoStore } from '@mitzo/client/hooks';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';
import { useVoice } from '../hooks/useVoice';
import { useProgressByToolId } from '../hooks/useProgress';
import { onKeyboardToggle } from '../lib/keyboard';
import type { ImageAttachment } from '../types/chat';

export function ChatView() {
  const [profileToolsTarget, setProfileToolsTarget] = useState<HTMLDivElement | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(
    () =>
      onKeyboardToggle((visible) => {
        setKeyboardOpen(visible);
        if (visible) {
          requestAnimationFrame(() => {
            scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight });
          });
        }
      }),
    [],
  );
  const { sessionId } = useParams<{ sessionId?: string }>();
  const searchParams = useChatDraftSearch(!sessionId);
  const [agentProfile, setAgentProfile] = useState<AgentProfileSelection | null>(null);
  const [agentProfileBlocked, setAgentProfileBlocked] = useState<string | undefined>();
  const onAgentProfileChange = useCallback(
    (selection: AgentProfileSelection | null, reason?: string) => {
      setAgentProfile(selection);
      setAgentProfileBlocked(reason);
    },
    [],
  );
  const navigate = useNavigate();
  // Store state
  const messages = useMessages();
  const historyLoading = useMitzoStore((s) => s.historyLoading);
  const historyError = useMitzoStore((s) => s.historyError);
  const connection = useConnection();
  const tokens = useTokens();
  const sendError = useMitzoStore((s) => s.sendError);
  const sendStatus = useMitzoStore((s) => s.sendStatus);
  const activeSessionId = useMitzoStore((s) => s.sessions.active);
  const conversationTitle = useMitzoStore(
    (s) => s.sessions.list?.find((item) => item.id === s.sessions.active)?.summary,
  );
  const preparationId = searchParams.get('repositoryPreparation');
  const repositoryHandoff = useRepositoryChatPreparation(preparationId, sessionId);
  const repositoryDraftControl = useRef<ChatInputDraftControl | null>(null);
  const modeChangeReady = useMitzoStore((s) => s.modeChangeReady);

  // Select individual action functions — stable references
  const storeInterruptMessage = useMitzoStore((s) => s.interruptMessage);
  const storeStopGeneration = useMitzoStore((s) => s.stopGeneration);
  const storeRespondToPermission = useMitzoStore((s) => s.respondToPermission);
  const storeExpirePermission = useMitzoStore((s) => s.expirePermission);
  const storeSwitchSession = useMitzoStore((s) => s.switchSession);
  const chatDraftRevision = useMitzoStore((s) => s.chatDraftRevision);
  const storeNewSession = useMitzoStore((s) => s.newSession);
  const storeCloseSession = useMitzoStore((s) => s.closeSession);
  const storeSetMode = useMitzoStore((s) => s.setMode);
  const storeSetModel = useMitzoStore((s) => s.setModel);
  const connectionId = useMitzoStore((s) => s.connection.clientId);
  const storeFetchSessionMeta = useMitzoStore((s) => s.fetchSessionMeta);
  const sessionContext = useMitzoStore((s) => s.messages.sessionContext);
  const bootContext = useMitzoStore((s) => s.messages.bootContext);
  const progressByToolId = useProgressByToolId();

  const {
    launch,
    launchSending,
    launchDeliveryPending,
    launchAccountError,
    saveLaunchAccount,
    dismissLaunch,
    sendMessage: storeSendMessage,
    sendLaunch,
    registrationError,
    registrationSaving,
    retryRegistration,
  } = usePendingLaunch(sessionId ? null : searchParams.get('draft'));
  const briefingChat = useBriefingChat(activeSessionId, launch);

  const savedLaunch = searchParams.get('draft')
    ? getChatDraft(searchParams.get('draft')!)?.settings.launch
    : undefined;
  const draftEnabled =
    !sessionId &&
    !activeSessionId &&
    !repositoryHandoff.present &&
    !launch &&
    !savedLaunch &&
    !launchDeliveryPending;
  const newChatDraft = useNewChatDraft(searchParams.get('draft'), chatDraftRevision, draftEnabled);
  const localCommand = useMitzoStore((s) => s.localCommand);
  const localTransportAvailable = useMitzoStore((s) => s.localFirstCommandTransportAvailable);
  const sendLocalFirstCommand = useMitzoStore((s) => s.sendLocalFirstCommand);
  const recoverLocalCommand = useMitzoStore((s) => s.recoverLocalCommand);
  const localRuntime = useExplicitLocalChat(
    newChatDraft.draft.id,
    newChatDraft.draft.settings.runtimeSelection,
    activeSessionId,
    !launch && !repositoryHandoff.present,
    searchParams.toString(),
    newChatDraft.restored ? newChatDraft.draft.settings.selection : undefined,
  );
  const explicitNew = localRuntime.visible && !activeSessionId;
  const localBound =
    localRuntime.bound || (!!activeSessionId && localCommand?.sessionId === activeSessionId);
  const localFirstCommand = explicitNew;
  const roleSearch = searchParams.toString();
  const roleIntent = useMemo(
    () => (!sessionId ? readTelosRoleIntent(new URLSearchParams(roleSearch)) : null),
    [sessionId, roleSearch],
  );
  const roleSetupRequested = !sessionId && searchParams.has('telosRoleItem');
  const invalidRoleSetup = roleSetupRequested && !roleIntent;
  const [roleSetupLocked, setRoleSetupLocked] = useState(false);
  const [roleDraftError, setRoleDraftError] = useState<string | null>(null);
  const flushRoleDraft = useCallback(() => {
    if (repositoryDraftControl.current?.flush?.() !== true) {
      setRoleDraftError('Could not preserve this draft. Keep this chat open and retry.');
      return false;
    }
    setRoleDraftError(null);
    return true;
  }, []);
  const controlsBlocked =
    roleSetupLocked ||
    (localBound && !localRuntime.continuation) ||
    localRuntime.metadataPending ||
    (!!sessionId && sessionId !== activeSessionId);

  const [builderLinkError, setBuilderLinkError] = useState('');
  const builderSources = activeSessionId
    ? messages.messages.flatMap((message) => message.sourceSnapshots ?? [])
    : newChatDraft.draft.settings.sourceSnapshots;
  const builderSourceReason =
    !activeSessionId && builderSources?.some((source) => source.kind === 'agent-library')
      ? searchParams.get('agentProfile') !== PROFILE_BUILDER_ID ||
        searchParams.get('agentProfileKind') !== 'builtin' ||
        !profileBuilderDefinitionForRevision(Number(searchParams.get('profileRevision')))
        ? 'Choose Agent Builder to use this reviewed Library context, or start a new chat.'
        : undefined
      : undefined;
  const missingDraftReason = newChatDraft.missing
    ? 'This draft is unavailable. Open Drafts or start a new chat.'
    : undefined;
  const draftSearch = new URLSearchParams(searchParams);
  draftSearch.delete('draft');
  draftSearch.delete('prompt');
  const settingsSearch = draftSearch.toString();

  const connected = connection.status === 'connected';

  // Local model state — persisted to localStorage, sent in payload
  const [modelState, setModelState] = useState(getPreferredModel);
  const [summaryForSession, setSummaryForSession] = useState<{
    sessionId: string | null;
    summary: WorkspaceSummary | null;
  } | null>(null);
  const workspaceSummary =
    summaryForSession?.sessionId === (activeSessionId ?? newChatDraft.draft.id)
      ? summaryForSession.summary
      : null;
  const [sessionTypeForScope, setSessionTypeForScope] = useState<{
    scope: string;
    type: 'chat' | 'symposium';
  } | null>(null);
  const currentSettingsScope = activeSessionId ?? newChatDraft.draft.id;
  const trustedSessionType =
    (!sessionId || sessionId === activeSessionId) &&
    sessionTypeForScope?.scope === currentSettingsScope
      ? sessionTypeForScope.type
      : undefined;
  const setWorkspaceSummary = useCallback(
    (summary: WorkspaceSummary | null) => {
      const scope = activeSessionId ?? newChatDraft.draft.id;
      setSummaryForSession({ sessionId: scope, summary });
      // A loading picker can clear its display summary, but cannot revoke the
      // current session's authoritative classification while moving surfaces.
      if (summary?.sessionType) setSessionTypeForScope({ scope, type: summary.sessionType });
    },
    [activeSessionId, newChatDraft.draft.id],
  );
  const isSymposium = trustedSessionType === 'symposium';
  const ordinaryControls = !activeSessionId || trustedSessionType === 'chat';
  const accountScope = !sessionId && !activeSessionId ? newChatDraft.draft.id : activeSessionId;
  const [accountChoice, setAccountChoice] = useState<{
    scope: string | null;
    selection: AccountSelection | null;
  } | null>(null);
  const accountSelection =
    explicitNew || localRuntime.continuation
      ? localRuntime.intent.account
      : accountChoice?.scope === accountScope
        ? accountChoice.selection
        : null;
  const [stagedAccountChoice, setStagedAccountChoice] = useState<{
    scope: string | null;
    selection: AccountSelection;
  } | null>(null);
  const stagedAccountSelection =
    stagedAccountChoice?.scope === accountScope ? stagedAccountChoice.selection : null;
  const saveStagedAccount = useCallback(
    (selection: AccountSelection) => {
      setStagedAccountChoice({ scope: accountScope, selection });
    },
    [accountScope],
  );
  const retainedDraftAccount = useRef<{ scope: string | null; selection: AccountSelection | null }>(
    { scope: accountScope, selection: newChatDraft.draft.settings.selection },
  );
  if (retainedDraftAccount.current.scope !== accountScope)
    retainedDraftAccount.current = {
      scope: accountScope,
      selection: newChatDraft.draft.settings.selection,
    };
  if (accountSelection) retainedDraftAccount.current.selection = accountSelection;
  const repositoryAccountSelection = draftEnabled
    ? (accountSelection ?? stagedAccountSelection ?? retainedDraftAccount.current.selection)
    : accountSelection;
  const repositoryScope = `${repositoryHandoff.present ? repositoryHandoff.scope : newChatDraft.draft.id}:${chatDraftRevision}:${repositoryAccountSelection?.accountId ?? ''}:${explicitNew ? '' : (repositoryAccountSelection?.model ?? '')}`;
  const [repositoryChoice, setRepositoryChoice] = useState<{
    scope: string;
    selection: RepositoryChatSelection | null;
  } | null>(null);
  const [repositoryAccountError, setRepositoryAccountError] = useState<{
    scope: string;
    message: string;
  } | null>(null);
  const repositoryAccountReason =
    repositoryAccountError?.scope === newChatDraft.draft.id
      ? repositoryAccountError.message
      : undefined;
  const [removedRepositoryScope, setRemovedRepositoryScope] = useState<string | null>(null);
  const initialRepositoryId =
    draftEnabled && removedRepositoryScope !== newChatDraft.draft.id
      ? newChatDraft.draft.settings.repositoryWorkspaceId
      : undefined;
  const repositorySelection =
    repositoryChoice?.scope === repositoryScope
      ? repositoryChoice.selection
      : repositoryHandoff.present
        ? { blocked: true }
        : draftEnabled
          ? initialRepositoryId
            ? { blocked: true, repositoryWorkspaceId: initialRepositoryId }
            : null
          : accountSelection?.accountId &&
              savedRepositoryDraft(accountSelection.accountId, accountSelection.model)
            ? { blocked: true }
            : null;
  const preparedModelEditable =
    explicitNew &&
    !localCommand?.request &&
    preparedRuntimeModelEditable(
      localRuntime.intent,
      localRuntime.inventory,
      repositorySelection?.ordinaryRuntime ?? repositoryHandoff.preparation?.ordinaryRuntime,
    );
  const preparedExecutionLocked = !!repositorySelection?.repositoryWorkspaceId;
  const repositoryHandoffReason =
    (repositoryHandoff.present && (messages.running || sendStatus)
      ? 'Waiting for repository conversation confirmation…'
      : undefined) ??
    repositoryChatSendDisabledReason(
      repositoryHandoff,
      activeSessionId,
      accountSelection,
      repositorySelection,
      preparedModelEditable,
    );

  const setModel = useCallback(
    (id: string) => {
      setModelState(id);
      setPreferredModel(id);
      storeSetModel(id);
    },
    [storeSetModel],
  );

  const restoredRepositoryBinding = useRef<string | null>(null);
  const hydrateAccount = useCallback(
    (selection: AccountSelection, hydratedSessionId: string) => {
      if (
        repositoryHandoff.present ||
        hydratedSessionId !== activeSessionId ||
        (sessionId && sessionId !== hydratedSessionId)
      )
        return;
      if (hydratedSessionId === repositoryHandoff.lastAssignedConversationId)
        restoredRepositoryBinding.current = hydratedSessionId;
      setAccountChoice({ scope: hydratedSessionId, selection });
      setModelState(selection.model);
      storeSetModel(selection.model);
    },
    [
      activeSessionId,
      sessionId,
      storeSetModel,
      repositoryHandoff.present,
      repositoryHandoff.lastAssignedConversationId,
    ],
  );
  const selectAccount = useCallback(
    (selection: AccountSelection | null) => {
      if (controlsBlocked || (repositoryHandoff.present && activeSessionId)) return;
      const binding = repositoryAccountSelection ?? newChatDraft.draft.settings.selection;
      if (
        draftEnabled &&
        repositorySelection?.repositoryWorkspaceId &&
        selection &&
        binding &&
        (binding.accountId !== selection.accountId ||
          (!preparedModelEditable && binding.model !== selection.model))
      ) {
        setRepositoryAccountError({
          scope: newChatDraft.draft.id,
          message: 'Remove the repository preparation before changing account or model.',
        });
        return;
      }
      if (selection) setRepositoryAccountError(null);
      if (selection && launch && !saveLaunchAccount(selection)) return;
      setAccountChoice({ scope: accountScope, selection });
      if (selection) {
        if (
          !!launch?.briefing ||
          briefingChat.selectionLocked ||
          repositoryHandoff.present ||
          (activeSessionId !== null &&
            activeSessionId === repositoryHandoff.lastAssignedConversationId &&
            restoredRepositoryBinding.current !== activeSessionId)
        ) {
          // Preserve browser defaults once while the assigned binding hydrates.
          // Later explicit model choices use the ordinary preference path.
          if (!repositoryHandoff.present) restoredRepositoryBinding.current = activeSessionId;
          setModelState(selection.model);
          storeSetModel(selection.model);
        } else setModel(selection.model);
      }
    },
    [
      controlsBlocked,
      launch,
      saveLaunchAccount,
      accountScope,
      repositoryAccountSelection,
      draftEnabled,
      newChatDraft.draft,
      repositorySelection?.repositoryWorkspaceId,
      preparedModelEditable,
      setModel,
      storeSetModel,
      activeSessionId,
      repositoryHandoff.present,
      repositoryHandoff.lastAssignedConversationId,
      briefingChat.selectionLocked,
    ],
  );

  const storeMode = useMitzoStore((s) => s.config.mode);
  const initialDraftMode = newChatDraft.restored
    ? newChatDraft.draft.settings.mode
    : searchParams.get('extraTools')
      ? 'auto'
      : storeMode;
  const [draftOptions, setDraftOptions] = useState({
    id: newChatDraft.draft.id,
    mode: initialDraftMode,
    isolation: newChatDraft.restored ? newChatDraft.draft.settings.isolation : true,
  });
  const mode = !draftEnabled
    ? storeMode
    : draftOptions.id === newChatDraft.draft.id
      ? draftOptions.mode
      : initialDraftMode;
  const isolation =
    draftOptions.id === newChatDraft.draft.id
      ? draftOptions.isolation
      : newChatDraft.restored
        ? newChatDraft.draft.settings.isolation
        : true;
  const setIsolation = useCallback(
    (value: boolean | ((old: boolean) => boolean)) => {
      setDraftOptions({
        id: newChatDraft.draft.id,
        mode,
        isolation: typeof value === 'function' ? value(isolation) : value,
      });
    },
    [newChatDraft.draft.id, mode, isolation],
  );
  const restoredOptionsScope = useRef<string | null>(null);
  useEffect(() => {
    if (!draftEnabled || restoredOptionsScope.current === newChatDraft.draft.id) return;
    restoredOptionsScope.current = newChatDraft.draft.id;
    setDraftOptions({ id: newChatDraft.draft.id, mode: initialDraftMode, isolation });
    if (initialDraftMode !== storeMode && modeChangeReady !== false) storeSetMode(initialDraftMode);
  }, [
    newChatDraft.draft.id,
    draftEnabled,
    initialDraftMode,
    isolation,
    storeMode,
    modeChangeReady,
    storeSetMode,
  ]);
  const [boundDraftOwner, setBoundDraftOwner] = useState<{
    sessionId: string | null;
    draftId: string | null;
  }>({ sessionId: null, draftId: null });
  useEffect(() => {
    const refresh = () => {
      const draftId = activeSessionId ? (getSessionChatDraft(activeSessionId)?.id ?? null) : null;
      setBoundDraftOwner((previous) =>
        previous.sessionId === activeSessionId && previous.draftId === draftId
          ? previous
          : { sessionId: activeSessionId, draftId },
      );
    };
    refresh();
    window.addEventListener(CHAT_DRAFTS_CHANGED, refresh);
    return () => window.removeEventListener(CHAT_DRAFTS_CHANGED, refresh);
  }, [activeSessionId]);
  const savedChatDraft = useMemo(
    () =>
      draftEnabled && !newChatDraft.missing
        ? {
            ...newChatDraft.draft,
            settings: {
              sourceSnapshots: newChatDraft.draft.settings.sourceSnapshots,
              retainRuntimeIntent: newChatDraft.draft.settings.retainRuntimeIntent,
              runtimeSelection: explicitNew
                ? localRuntime.intent
                : newChatDraft.draft.settings.runtimeSelection,
              selection: explicitNew
                ? localRuntime.intent.account
                : (repositoryAccountSelection ?? newChatDraft.draft.settings.selection),
              summary: workspaceSummary ?? newChatDraft.draft.settings.summary,
              mode,
              isolation,
              repositoryWorkspaceId: repositorySelection?.repositoryWorkspaceId ?? null,
              search: settingsSearch,
            },
          }
        : activeSessionId &&
            (boundDraftOwner.sessionId !== activeSessionId || boundDraftOwner.draftId !== null)
          ? (getSessionChatDraft(activeSessionId) ?? undefined)
          : undefined,
    [
      activeSessionId,
      boundDraftOwner,
      draftEnabled,
      newChatDraft.draft,
      newChatDraft.missing,
      repositoryAccountSelection,
      workspaceSummary,
      mode,
      isolation,
      repositorySelection?.repositoryWorkspaceId,
      explicitNew,
      localRuntime.intent,
      settingsSearch,
    ],
  );
  const saveDraftSettings = newChatDraft.saveSettings;
  useEffect(() => {
    if (savedChatDraft) saveDraftSettings(savedChatDraft.settings);
  }, [savedChatDraft, saveDraftSettings]);
  const releaseDraftReference = newChatDraft.releaseReference;
  useEffect(() => {
    if (!draftEnabled || newChatDraft.missing) return;
    const retainUrl = () => {
      const saved = getChatDraft(newChatDraft.draft.id);
      const referencedId = searchParams.get('draft');
      if (saved && referencedId === newChatDraft.draft.id) return;
      if (!saved && referencedId !== newChatDraft.draft.id) return;
      const params = new URLSearchParams(searchParams);
      if (saved) params.set('draft', newChatDraft.draft.id);
      else {
        // An emptied draft has no persistent owner. Keep this mounted composer’s
        // settings, but reload must open a blank chat rather than a missing ID.
        releaseDraftReference();
        params.delete('draft');
        params.delete('prompt');
      }
      const query = params.toString();
      navigate(`/chat${query ? `?${query}` : ''}`, { replace: true });
    };
    retainUrl();
    window.addEventListener(CHAT_DRAFTS_CHANGED, retainUrl);
    return () => window.removeEventListener(CHAT_DRAFTS_CHANGED, retainUrl);
  }, [
    draftEnabled,
    newChatDraft.draft.id,
    newChatDraft.missing,
    searchParams,
    navigate,
    releaseDraftReference,
  ]);

  const voice = useVoice();
  const scrollRef = useRef<HTMLDivElement>(null);

  const forceScrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  const awaitingNewSession = useRef(false);
  const clearedSessionId = useRef<string | null>(null);
  const resetFailedDraftOnMount = useRef(
    !sessionId && !activeSessionId && !messages.running && messages.messages.length > 0,
  );

  // Sync route param → store session
  useEffect(() => {
    awaitingNewSession.current = !sessionId;
    clearedSessionId.current = !sessionId ? activeSessionId : null;
    if (sessionId && sessionId !== activeSessionId) {
      storeSwitchSession(sessionId);
    } else if (
      !sessionId &&
      (preparationId !== null || activeSessionId || resetFailedDraftOnMount.current) &&
      !launch?.draftId
    ) {
      // Ignore the old ID while waiting for the new one, even when reset and
      // assignment are batched without an intermediate render.
      storeNewSession();
    }
  }, [sessionId, preparationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist active session to localStorage
  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(LAST_SESSION_KEY, activeSessionId);
    }
  }, [activeSessionId]);

  // Navigate away when session expires (store clears active while route still has :id)
  const hadSession = useRef(false);
  useEffect(() => {
    if (activeSessionId) hadSession.current = true;
    if (sessionId && !activeSessionId && hadSession.current) {
      hadSession.current = false;
      localStorage.removeItem(LAST_SESSION_KEY);
      navigate('/chat', { replace: true });
    }
  }, [activeSessionId, sessionId, navigate]);

  // When store assigns a session (new conversation), update URL
  useEffect(() => {
    if (!sessionId && !activeSessionId) awaitingNewSession.current = true;
    if (
      activeSessionId &&
      activeSessionId !== clearedSessionId.current &&
      !sessionId &&
      awaitingNewSession.current &&
      (!repositoryHandoff.present || repositoryHandoff.assignedConversationId === activeSessionId)
    ) {
      awaitingNewSession.current = false;
      navigate(`/chat/${activeSessionId}`, { replace: true });
    }
  }, [
    activeSessionId,
    sessionId,
    navigate,
    repositoryHandoff.present,
    repositoryHandoff.assignedConversationId,
  ]);

  // Hydrate branch/worktree/token state from persisted metadata
  useEffect(() => {
    if (sessionId) {
      storeFetchSessionMeta(sessionId);
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──────────────────────────────────────────────────────────────

  function handleSend(
    text: string,
    images?: ImageAttachment[],
    ctxBlocks?: string[],
    launching = false,
    onDelivery?: import('@mitzo/client').SendMessageOptions['onDelivery'],
    onSessionAssigned?: import('@mitzo/client').SendMessageOptions['onSessionAssigned'],
  ): boolean {
    if (roleSetupRequested || controlsBlocked || builderSourceReason) return false;
    if (localRuntime.continuation && activeSessionId) {
      if (
        ctxBlocks?.length ||
        launching ||
        localRuntime.reason ||
        !localRuntime.repositoryWorkspaceId
      )
        return false;
      const command = prepareLocalContinuationCommand(localRuntime.intent, localRuntime.inventory, {
        sessionId: activeSessionId,
        clientMsgId: createBrowserId(),
        repositoryWorkspaceId: localRuntime.repositoryWorkspaceId,
        mode: localRuntime.mode ?? 'agent',
        retainedAgentProfile: localRuntime.agentProfile,
        retainedAgentContext: localRuntime.agentContext,
        nativeConstraint: localRuntime.nativeConstraint,
        text,
        images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
      });
      return !!command.request && sendLocalFirstCommand(command.request, { onDelivery });
    }
    if (explicitNew) {
      if (
        !localFirstCommand ||
        localRuntime.reason ||
        (localCommand && localCommand.state !== 'consumed') ||
        !repositorySelection?.repositoryWorkspaceId ||
        repositorySelection.blocked ||
        ctxBlocks?.length ||
        launching ||
        missingDraftReason ||
        repositoryAccountReason
      )
        return false;
      const command = buildLocalFirstCommand(localRuntime.intent, localRuntime.inventory, {
        clientMsgId: createBrowserId(),
        repositoryWorkspaceId: repositorySelection.repositoryWorkspaceId,
        mode,
        text,
        sourceSnapshots: newChatDraft.draft.settings.sourceSnapshots,
        images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
      });
      if (!command) return false;
      return sendLocalFirstCommand(command, {
        draftId: newChatDraft.draft.id,
        onDelivery,
        onSessionAssigned: (assignedId) => {
          try {
            markAgentBuilderAssigned(newChatDraft.draft, assignedId);
          } catch {
            setBuilderLinkError(
              'The conversation opened, but its Agent Library return link could not be saved. Keep this conversation open.',
            );
          }
          if (accountSelection?.accountId)
            consumeRepositoryDraft(
              repositoryDraftKey(accountSelection.accountId, accountSelection.model),
              repositorySelection.repositoryWorkspaceId!,
            );
          onSessionAssigned?.(assignedId);
        },
      });
    }
    if (localRuntime.reason) return false;
    if (
      missingDraftReason ||
      repositoryAccountReason ||
      repositoryHandoffReason ||
      (repositoryHandoff.present && launching)
    )
      return false;
    if (launch?.briefing && !launching) return false;
    if (!activeSessionId && agentProfileBlocked) return false;
    if (launching && activeSessionId) return sendLaunch();
    if (!activeSessionId && (!accountSelection || repositorySelection?.blocked)) return false;
    // Prompt delivery has its own authenticated outbox and acknowledgement;
    // event-stream recovery must not block an existing conversation's input.
    voice.stopSpeaking();
    // Codex supports per-turn model changes. The server ignores these fields for
    // sessions bound to other providers and rejects cross-account rebinding.
    const options = {
      images,
      contextBlocks: ctxBlocks,
      ...(!activeSessionId ? { sourceSnapshots: newChatDraft.draft.settings.sourceSnapshots } : {}),
      ...(onDelivery ? { onDelivery } : {}),
      ...(accountSelection ?? {}),
      ...(!activeSessionId && repositorySelection?.repositoryWorkspaceId
        ? {
            repositoryWorkspaceId: repositorySelection.repositoryWorkspaceId,
            onSessionAssigned: (assignedId: string) => {
              if (repositoryHandoff.present) {
                if (!repositoryHandoff.markAssigned(assignedId)) return;
                const promptKey = repositoryPromptDraftKey(repositoryHandoff.id!);
                if (repositoryDraftControl.current?.storageKey === promptKey)
                  repositoryDraftControl.current.clear();
                else {
                  try {
                    localStorage.removeItem(promptKey);
                  } catch {
                    /* Optional browser storage. */
                  }
                }
              }
              if (accountSelection?.accountId)
                consumeRepositoryDraft(
                  repositoryDraftKey(accountSelection.accountId, accountSelection.model),
                  repositorySelection.repositoryWorkspaceId!,
                );
            },
          }
        : {}),
      mode,
      cwd: searchParams.get('cwd') ?? undefined,
      extraTools: searchParams.get('extraTools') ?? undefined,
      ...(!activeSessionId && agentProfile ? { agentProfile } : {}),
      ...(!activeSessionId && !isolation ? { isolation: false } : {}),
    };
    if (onSessionAssigned || newChatDraft.draft.settings.sourceSnapshots?.length) {
      const originalAssignment = options.onSessionAssigned;
      options.onSessionAssigned = (assignedId: string) => {
        originalAssignment?.(assignedId);
        try {
          markAgentBuilderAssigned(newChatDraft.draft, assignedId);
        } catch {
          setBuilderLinkError(
            'The conversation opened, but its Agent Library return link could not be saved. Keep this conversation open.',
          );
        }
        onSessionAssigned?.(assignedId);
      };
    }
    try {
      const queued = launching ? sendLaunch(options) : storeSendMessage(text, options);
      forceScrollToBottom();
      // The legacy wrapper reports queued even when the transport rejects it.
      // Keep the reviewed prompt until this exact launch assigns a conversation.
      return repositoryHandoff.present ? false : queued;
    } catch (error) {
      if (!repositoryHandoff.present) throw error;
      // A thrown transport may already have sent bytes; retain its pending fence.
      return false;
    }
  }

  function handleInterrupt(
    text: string,
    images?: ImageAttachment[],
    ctxBlocks?: string[],
    onDelivery?: import('@mitzo/client').SendMessageOptions['onDelivery'],
  ): void {
    if (controlsBlocked || explicitNew || localBound) {
      onDelivery?.('failed');
      return;
    }
    if (repositoryHandoff.present) {
      onDelivery?.('failed');
      return;
    }
    voice.stopSpeaking();
    // Preserve the same per-turn Codex selection when interrupting an active turn.
    storeInterruptMessage(text, {
      images,
      contextBlocks: ctxBlocks,
      onDelivery,
      ...(accountSelection ?? {}),
    });
    forceScrollToBottom();
  }

  const handleStop = useCallback(() => {
    storeStopGeneration();
    // Only server state confirms completion; a rejected Stop must retain the active turn.
  }, [storeStopGeneration]);

  function handlePermission(
    permId: string,
    decision: 'once' | 'always' | 'deny',
    _toolName: string,
    answers?: import('@mitzo/protocol').QuestionAnswers,
  ) {
    storeRespondToPermission(permId, decision, answers);
  }

  function handleModeChange(newMode: 'ask' | 'agent' | 'auto') {
    if (controlsBlocked) return;
    if (draftEnabled) setDraftOptions({ id: newChatDraft.draft.id, mode: newMode, isolation });
    storeSetMode(newMode);
  }

  const initialPrompt = repositoryHandoff.present
    ? repositoryHandoff.preparation?.prompt
    : searchParams.get('prompt') || undefined;

  const compactionHistory = useCompactionHistory(
    activeSessionId,
    `${tokens.numCompactions}:${tokens.compactionPhase ?? ''}:${messages.running}`,
  );
  const [agentLabel, setAgentLabel] = useState<string | undefined>(undefined);
  const accountModelControl =
    !repositoryHandoff.present || activeSessionId || repositoryHandoff.preparation ? (
      <AccountModelPicker
        presentation="settings"
        controlled={
          explicitNew || localRuntime.continuation
            ? {
                accounts: runtimeModelAccounts(localRuntime.intent, localRuntime.inventory),
                accountNeedsConfirmation: localRuntime.accountNeedsConfirmation,
                onRefresh: localRuntime.refresh,
                selection: localRuntime.intent.account,
                onAccountChange: (selection) =>
                  localRuntime.update(
                    {
                      ...localRuntime.intent,
                      account: selection,
                      capabilityRevision: null,
                    },
                    true,
                  ),
                onChange: (selection) =>
                  localRuntime.update({
                    ...localRuntime.intent,
                    account: selection,
                    capabilityRevision: null,
                  }),
              }
            : undefined
        }
        key={`${chatDraftRevision}:${newChatDraft.draft.id}`}
        initialSelection={
          launch && !launch.briefing
            ? launch.accountSelection
            : draftEnabled
              ? (newChatDraft.draft.settings.selection ?? undefined)
              : undefined
        }
        lockAccount={localBound || preparedExecutionLocked}
        lockAccountModel={draftEnabled && preparedExecutionLocked && !preparedModelEditable}
        requiredSelection={
          !activeSessionId && repositoryHandoff.preparation && !preparedModelEditable
            ? {
                accountId: repositoryHandoff.preparation.accountId,
                model: repositoryHandoff.preparation.model,
              }
            : !activeSessionId
              ? launch?.briefing
                ? launch.accountSelection
                : undefined
              : undefined
        }
        disabled={
          (messages.running && !localRuntime.continuation) ||
          controlsBlocked ||
          repositoryHandoff.loading ||
          briefingChat.selectionLocked ||
          launchSending
        }
        sessionId={activeSessionId}
        preferredModel={modelState}
        onDraftSelectionChange={
          draftEnabled
            ? saveStagedAccount
            : launch && !launch.briefing
              ? saveLaunchAccount
              : undefined
        }
        onChange={selectAccount}
        onSessionHydrated={hydrateAccount}
        onSummaryChange={setWorkspaceSummary}
      />
    ) : (
      <span>Waiting for repository preparation…</span>
    );
  const agentControl = (
    <ChatAgentProfilePicker
      label="Agent"
      onLabelChange={setAgentLabel}
      controlled={
        explicitNew || localRuntime.continuation
          ? {
              versions: localRuntime.inventory?.agentProfiles ?? [],
              selection: localRuntime.intent.agentProfile,
              onChange: (agentProfile) =>
                localRuntime.update({
                  ...localRuntime.intent,
                  agentProfile,
                  capabilityRevision: null,
                }),
            }
          : undefined
      }
      key={`agent-profile:${chatDraftRevision}`}
      sessionId={activeSessionId}
      search={searchParams.toString()}
      onChange={onAgentProfileChange}
      disabled={messages.running || controlsBlocked || localBound}
    />
  );
  const executionControl = (
    <ChatExecutionPicker
      presentation="settings"
      executionLocked={preparedExecutionLocked}
      runtime={localRuntime}
      disabled={
        (messages.running && !localRuntime.continuation) ||
        (!!localCommand && localCommand.state !== 'consumed')
      }
    />
  );
  const runtimeModelLabel =
    runtimeModelAccounts(localRuntime.intent, localRuntime.inventory)
      .find((account) => account.id === localRuntime.intent.account?.accountId)
      ?.models.find((model) => model.id === localRuntime.intent.account?.model)?.label ??
    localRuntime.intent.account?.model;
  const agentHarness = localRuntime.bound
    ? localRuntime.binding?.harness.implementation
    : selectedRuntimeRoute(localRuntime.intent, localRuntime.inventory)?.harness;
  const agentSoftware =
    agentHarness === 'codex'
      ? 'Codex'
      : agentHarness === 'responses'
        ? 'Mitzo Responses'
        : agentHarness === 'claude-sdk'
          ? 'Claude'
          : agentHarness === 'gemini'
            ? 'Gemini'
            : undefined;
  const repositoryControl = !activeSessionId &&
    repositoryAccountSelection?.accountId &&
    (!repositoryHandoff.present ||
      (repositoryHandoff.preparation &&
        repositoryAccountSelection.accountId === repositoryHandoff.preparation.accountId &&
        (preparedModelEditable ||
          repositoryAccountSelection.model === repositoryHandoff.preparation.model))) && (
      <RepositoryChatPicker
        presentation="settings"
        key={repositoryScope}
        accountId={repositoryAccountSelection.accountId}
        model={repositoryAccountSelection.model}
        draftScoped={draftEnabled}
        ordinaryRuntime={
          explicitNew &&
          localRuntime.intent.accountReference &&
          localRuntime.intent.execution.targetId &&
          selectedRuntimeRoute(localRuntime.intent, localRuntime.inventory)
            ? {
                runOn: localRuntime.intent.execution.location,
                runtime: {
                  account: localRuntime.intent.accountReference,
                  harness: selectedRuntimeRoute(localRuntime.intent, localRuntime.inventory)!
                    .harness,
                  targetId: localRuntime.intent.execution.targetId,
                },
              }
            : undefined
        }
        initialPreparationId={repositoryHandoff.preparation?.id ?? initialRepositoryId ?? undefined}
        onChange={(selection) => {
          setRepositoryChoice({ scope: repositoryScope, selection });
          if (!selection) {
            setRepositoryAccountError(null);
            setRemovedRepositoryScope(newChatDraft.draft.id);
          }
          if (repositoryHandoff.present && !selection) navigate('/chat', { replace: true });
        }}
      />
    );

  const settings = !isSymposium ? (
    <AgentSettingsFields
      repository={repositoryControl}
      agent={agentControl}
      accountModel={accountModelControl}
      execution={executionControl}
      details={
        activeSessionId ? (
          <details className="composer-session-details" open>
            <summary>Session details</summary>
            <dl>
              <dt>Account</dt>
              <dd>
                {localRuntime.bound
                  ? (localRuntime.inventory?.accounts.find(
                      (item) => item.account.accountId === localRuntime.intent.account?.accountId,
                    )?.label ?? 'Unavailable')
                  : (workspaceSummary?.profile ?? 'Unavailable')}
              </dd>
              <dt>Agent</dt>
              <dd>{agentLabel ?? 'Unavailable'}</dd>
              <dt>Model</dt>
              <dd>
                {localRuntime.bound
                  ? (runtimeModelLabel ?? 'Unavailable')
                  : (workspaceSummary?.model ?? 'Unavailable')}
              </dd>
              <dt>Thinking level</dt>
              <dd>
                {localRuntime.bound
                  ? (localRuntime.intent.account?.reasoningEffort ?? 'Unavailable')
                  : (workspaceSummary?.thinking ?? 'Unavailable')}
              </dd>
              <dt>Run on</dt>
              <dd>
                {(explicitNew || localRuntime.continuation
                  ? localRuntime.intent.execution.location
                  : workspaceSummary?.location) === 'local'
                  ? 'Local Mac'
                  : (explicitNew || localRuntime.continuation
                        ? localRuntime.intent.execution.location
                        : workspaceSummary?.location) === 'openshell'
                    ? 'OpenShell'
                    : 'Unavailable'}
              </dd>
              <dt>Agent software</dt>
              <dd>{agentSoftware ?? 'Unavailable'}</dd>
              <dt>Workspace</dt>
              <dd>{localRuntime.repositoryWorkspaceId ?? messages.wtId ?? 'Unavailable'}</dd>
              <dt>Branch</dt>
              <dd>{messages.branch || 'Unavailable'}</dd>
            </dl>
          </details>
        ) : undefined
      }
    />
  ) : undefined;

  const workspaceControls = (
    <WorkspaceControls
      title={
        !activeSessionId
          ? 'New chat'
          : briefingChat.isBriefing
            ? briefingChat.name
            : conversationTitle || 'Chat'
      }
      leading={
        <Link to="/sessions" className="chat-top-action" aria-label="Back to chats">
          <UiIcon name="back" />
        </Link>
      }
      trailing={
        <button
          type="button"
          className="chat-top-action"
          aria-label="New chat"
          onClick={() => {
            storeNewSession();
            navigate('/chat');
          }}
        >
          <UiIcon name="edit" />
        </button>
      }
      settings={settings}
      agent={!isSymposium ? (agentLabel ?? 'Mitzo') : undefined}
      scopeKey={activeSessionId ?? newChatDraft.draft.id}
      onDone={explicitNew || localRuntime.continuation ? localRuntime.review : undefined}
      actions={
        <>
          {activeSessionId && !isSymposium && !controlsBlocked && (
            <ConversationAgents
              compact
              scope={activeSessionId}
              agents={[
                {
                  id: activeSessionId,
                  name: agentLabel ?? 'Mitzo',
                  account: workspaceSummary?.profile,
                  model: workspaceSummary?.model,
                  thinking: workspaceSummary?.thinking,
                  state: 'Current conversation',
                },
              ]}
              messages={messages.messages}
            />
          )}
          <SessionAccess
            sessionId={repositoryHandoff.present ? undefined : (activeSessionId ?? undefined)}
            selection={accountSelection}
            connected={connected}
          />
        </>
      }
      attention={!!roleIntent || !!launch || repositoryHandoff.present || !!localRuntime.reason}
      summary={
        explicitNew || localRuntime.continuation
          ? {
              profile:
                localRuntime.inventory?.accounts.find(
                  (a) => a.account.accountId === localRuntime.intent.account?.accountId,
                )?.label ?? 'Choose account',
              model: runtimeModelLabel,
              thinking: localRuntime.intent.account?.reasoningEffort ?? undefined,
              location: localRuntime.intent.execution.location,
            }
          : workspaceSummary
      }
      status={
        explicitNew
          ? localRuntime.reason
            ? 'Needs review'
            : 'First command'
          : localBound
            ? localRuntime.continuation
              ? 'Conversation'
              : 'First command'
            : localRuntime.metadataPending
              ? localRuntime.metadataUnavailable
                ? 'Needs review'
                : 'Loading conversation settings'
              : isSymposium
                ? 'Agent chat'
                : activeSessionId && !ordinaryControls
                  ? 'Loading conversation settings'
                  : !connected
                    ? 'Reconnecting'
                    : messages.running
                      ? 'Working'
                      : 'Ready'
      }
    >
      <div className="chat-account-bar">
        {isSymposium && accountModelControl}
        {isSymposium && agentControl}
        {isSymposium && executionControl}
        {localCommand && (
          <div className="chat-agent-profile" role="status">
            <span>
              {localCommand.state === 'consumed'
                ? localRuntime.continuation
                  ? 'Conversation connected.'
                  : `Original ${localCommand.request?.runOn === 'openshell' ? 'OpenShell' : 'Local'} command dispatched.`
                : `${localCommand.request?.runOn === 'openshell' ? 'OpenShell' : 'Local'} command retained. Review its original choices before recovery.`}
            </span>
            {localCommand.request && (
              <span>
                {localRuntime.continuation && localCommand.state === 'consumed'
                  ? 'Last submitted command: '
                  : ''}
                Account: {localCommand.request.runtime.account.accountId} · Model:{' '}
                {localCommand.request.selection.model} · Thinking:{' '}
                {localCommand.request.selection.thinking ?? 'not configurable'} · Agent revision:{' '}
                {localCommand.request.selection.agent.revision} · Execution target:{' '}
                {localCommand.request.runtime.targetId}
              </span>
            )}
            {localCommand.originDraftId && (
              <Link to={`/chat?draft=${encodeURIComponent(localCommand.originDraftId)}`}>
                Open original draft
              </Link>
            )}
            {localCommand.sessionId && (
              <Link to={`/chat/${localCommand.sessionId}`}>Open retained conversation</Link>
            )}
            <button
              type="button"
              disabled={
                !connected ||
                localCommand.state === 'consumed' ||
                localCommand.state === 'blocked' ||
                localCommand.state === 'pending'
              }
              onClick={() => recoverLocalCommand()}
            >
              Recover original {localCommand.request?.runOn === 'openshell' ? 'OpenShell' : 'Local'}{' '}
              command
            </button>
          </div>
        )}
      </div>
      <header className="chat-header">
        {!connected && (
          <span
            className="chat-header-offline"
            title={messages.running ? 'Reconnecting — session still active' : 'Reconnecting...'}
          >
            !
          </span>
        )}

        {!keyboardOpen && ordinaryControls && (
          <>
            <PermissionModePicker
              mode={mode}
              onChange={handleModeChange}
              disabled={controlsBlocked || localBound || modeChangeReady === false}
            />
            {activeSessionId && !controlsBlocked && (
              <button
                className="session-close-btn"
                onClick={() => {
                  if (ordinaryControls && !controlsBlocked) storeCloseSession();
                }}
                title="Close session"
              >
                <UiIcon name="close" size={16} />
              </button>
            )}
            <VoiceSettings
              ttsAvailable={voice.ttsAvailable}
              voices={voice.voices}
              selectedVoice={voice.selectedVoice}
              onVoiceChange={voice.setVoice}
            />
          </>
        )}
      </header>
      {activeSessionId && (
        <div className="mobile-session-context">
          <StatusBar
            connected={connected}
            sessionId={activeSessionId}
            branch={messages.branch || undefined}
            isWorktree={messages.isWorktree}
            wtId={messages.wtId || undefined}
          />
        </div>
      )}

      <div className="workspace-session-settings">
        {ordinaryControls && !explicitNew && !controlsBlocked && !localBound && (
          <WebSearchConsent
            key={activeSessionId ?? 'new'}
            sessionId={activeSessionId}
            mode={mode}
            connected={connected}
            connectionId={connectionId}
            running={messages.running}
          />
        )}
        <div className="workspace-session-actions">
          {activeSessionId &&
            !controlsBlocked &&
            !localBound &&
            (ordinaryControls ? null : isSymposium ? (
              <AddAgentSheet sessionId={activeSessionId} />
            ) : null)}
          {activeSessionId && isSymposium && (
            <SymposiumReviewEntry
              key={activeSessionId}
              sessionId={activeSessionId}
              readOnly={controlsBlocked || localBound}
            />
          )}
        </div>
        {activeSessionId && isSymposium && !controlsBlocked && !localBound && (
          <SymposiumDirectorPanel sessionId={activeSessionId} />
        )}
        <div ref={setProfileToolsTarget} />
      </div>
    </WorkspaceControls>
  );

  return (
    <div
      className={`chat-page workspace-chat${!activeSessionId ? ' chat-page--new' : ''}${keyboardOpen ? ' keyboard-open' : ''}`}
    >
      <div className="chat-mobile-topbar">
        <h1 className="sr-only">
          {briefingChat.isBriefing
            ? briefingChat.name
            : activeSessionId
              ? 'Conversation'
              : 'New chat'}
        </h1>
        <BriefingChatBanner
          name={briefingChat.name}
          initialSelection={
            accountSelection ??
            launch?.accountSelection ??
            (briefingChat.binding
              ? { accountId: briefingChat.binding.accountId, model: briefingChat.binding.model }
              : undefined)
          }
          source={briefingChat.source}
          registrationError={registrationError}
          registrationSaving={registrationSaving}
          retryRegistration={retryRegistration}
          lookupError={briefingChat.error}
          retryLookup={briefingChat.retry}
          lookupLoading={briefingChat.loading}
        />
        {!isSymposium && workspaceControls}
      </div>

      <TelosSourceWorkLink conversationId={activeSessionId ?? undefined} />
      <AgentLibraryChatLink sources={builderSources} />
      {builderLinkError && <p role="alert">{builderLinkError}</p>}

      {(sendError || sendStatus) && (
        <div
          role={sendError ? 'alert' : 'status'}
          className={
            sendError ? 'chat-delivery-status chat-delivery-error' : 'chat-delivery-status'
          }
        >
          {sendError || sendStatus}
        </div>
      )}

      {(historyLoading || (sessionId && sessionId !== activeSessionId)) && (
        <div role="status">Loading conversation…</div>
      )}
      {historyError && (
        <div role="alert">
          {historyError}{' '}
          <button
            type="button"
            onClick={() => {
              if (sessionId) void storeSwitchSession(sessionId);
            }}
          >
            Retry loading conversation
          </button>
        </div>
      )}
      {!roleIntent && (
        <ChatWelcome
          active={
            !activeSessionId &&
            !briefingChat.isBriefing &&
            !messages.running &&
            messages.messages.length === 0 &&
            !messages.current
          }
        />
      )}
      <SymposiumConversation
        onContinueInNewChat={(text) => {
          const path = newChatPathWithDraft(text);
          storeNewSession();
          navigate(path);
        }}
        conversationLayout={{
          settings: workspaceControls,
          showHeader: isSymposium,
          leading: (
            <Link to="/sessions" className="chat-top-action" aria-label="Back to chats">
              <UiIcon name="back" />
            </Link>
          ),
          actions: (
            <>
              <SessionAccess
                sessionId={activeSessionId ?? undefined}
                selection={accountSelection}
                connected={connected}
              />
              <button
                type="button"
                className="chat-top-action"
                aria-label="New chat"
                onClick={() => {
                  storeNewSession();
                  navigate('/chat');
                }}
              >
                <UiIcon name="edit" />
              </button>
            </>
          ),
        }}
        ordinaryConfirmed={
          (!sessionId || sessionId === activeSessionId) && !isSymposium && localRuntime.bound
        }
        ordinaryExcluded={isSymposium}
        ordinaryProfileProposalReview={
          localRuntime.bound &&
          !localRuntime.metadataPending &&
          (!sessionId || sessionId === activeSessionId) &&
          !isSymposium
        }
        profileToolsTarget={profileToolsTarget}
        readOnly={controlsBlocked || localBound}
        sessionId={sessionId ?? activeSessionId}
        chat={{
          afterMessages: !isSymposium ? (
            <TelosAdvisorDraft conversationId={activeSessionId ?? undefined} />
          ) : undefined,
          compactions: compactionHistory.records,
          sessionId: sessionId || activeSessionId || undefined,
          messages: sessionId && sessionId !== activeSessionId ? [] : messages.messages,
          current: sessionId && sessionId !== activeSessionId ? null : messages.current,
          currentByMessage:
            sessionId && sessionId !== activeSessionId ? {} : messages.currentByMessage,
          running: messages.running,
          permission: messages.permission,
          onPermissionRespond: handlePermission,
          onPermissionExpire: storeExpirePermission,
          scrollRef,
          progressByToolId,
          voice,
        }}
        ordinaryComposer={
          <div
            className={`conversation-composer${!activeSessionId ? ' conversation-composer--new' : ''}`}
          >
            <RepositoryChatDraftNotice handoff={repositoryHandoff} />
            {missingDraftReason && <div role="alert">{missingDraftReason}</div>}
            {repositoryAccountReason && <div role="alert">{repositoryAccountReason}</div>}
            {draftEnabled && repositorySelection?.repositoryWorkspaceId && (
              <p role="status">
                {preparedModelEditable
                  ? 'The prepared checkout keeps its account and environment. Model and thinking apply to the first message.'
                  : 'Remove the repository preparation to change account or model.'}
              </p>
            )}
            {newChatDraft.settingsError && (
              <div role="alert">Draft settings could not be saved on this device.</div>
            )}
            {launch && !repositoryHandoff.present && (
              <div role="status" className="chat-account-bar">
                <p>
                  Which account and model should handle this task? Check Agent settings, then send.
                </p>
                <details className="chat-launch-prompt">
                  <summary>Review launch prompt</summary>
                  <p>{launch.prompt}</p>
                </details>
                <button
                  disabled={
                    launchSending ||
                    (!activeSessionId &&
                      (!accountSelection || messages.running || repositorySelection?.blocked))
                  }
                  onClick={() => handleSend(launch.prompt, undefined, undefined, true)}
                >
                  {activeSessionId ? 'Review launch in new chat' : 'Send launch prompt'}
                </button>
                <button onClick={dismissLaunch}>Dismiss launch</button>
              </div>
            )}

            {!controlsBlocked && <CodexQueueStatus sessionId={activeSessionId} />}
            {invalidRoleSetup && (
              <p role="alert">
                This work conversation setup is unavailable. Return to the work item and choose a
                supported role.
              </p>
            )}
            {roleIntent && roleDraftError && <p role="alert">{roleDraftError}</p>}
            {roleIntent && (
              <TelosRoleSetup
                intent={roleIntent}
                runtime={localRuntime}
                repositoryWorkspaceId={repositorySelection?.repositoryWorkspaceId}
                mode={mode}
                draftId={newChatDraft.draft.id}
                onLocked={setRoleSetupLocked}
                beforeConfirm={flushRoleDraft}
                onBound={(id) => {
                  if (!flushRoleDraft()) return;
                  if (getSessionChatDraft(id)) {
                    navigate(`/chat/${encodeURIComponent(id)}`);
                    return;
                  }
                  const result = bindChatDraftToSession(newChatDraft.draft.id, id);
                  if (result === 'failed') {
                    setRoleDraftError(
                      'Could not preserve this draft. Keep this chat open and retry.',
                    );
                    return;
                  }
                  setRoleDraftError(null);
                  navigate(`/chat/${encodeURIComponent(id)}`);
                }}
              />
            )}
            <ChatInput
              collaboration={
                activeSessionId && !controlsBlocked && !localBound && ordinaryControls ? (
                  <OrdinaryCollaborationEntry sessionId={activeSessionId} compact />
                ) : undefined
              }
              compactions={compactionHistory.records}
              compactionError={compactionHistory.error}
              compactionTruncated={compactionHistory.truncated}
              sendLabel={!activeSessionId && ordinaryControls ? 'Start session' : undefined}
              boundedFirstCommand={localFirstCommand || controlsBlocked}
              guardedConversation={localRuntime.continuation}
              validateSend={
                localRuntime.continuation && activeSessionId && localRuntime.repositoryWorkspaceId
                  ? (text, images) =>
                      prepareLocalContinuationCommand(localRuntime.intent, localRuntime.inventory, {
                        sessionId: activeSessionId,
                        clientMsgId: createBrowserId(),
                        repositoryWorkspaceId: localRuntime.repositoryWorkspaceId!,
                        mode: localRuntime.mode ?? 'agent',
                        retainedAgentProfile: localRuntime.agentProfile,
                        retainedAgentContext: localRuntime.agentContext,
                        nativeConstraint: localRuntime.nativeConstraint,
                        text,
                        images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
                      }).reason
                  : localFirstCommand && repositorySelection?.repositoryWorkspaceId
                    ? (text, images) =>
                        prepareLocalFirstCommand(localRuntime.intent, localRuntime.inventory, {
                          clientMsgId: createBrowserId(),
                          repositoryWorkspaceId: repositorySelection.repositoryWorkspaceId!,
                          mode,
                          text,
                          sourceSnapshots: newChatDraft.draft.settings.sourceSnapshots,
                          images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
                        }).reason
                    : undefined
              }
              savedChatDraft={savedChatDraft}
              composerGeneration={chatDraftRevision}
              key={
                repositoryHandoff.present
                  ? `${repositoryHandoff.scope}:${repositoryHandoff.preparation ? 'loaded' : 'loading'}`
                  : undefined
              }
              onSend={(text, images, context, onDelivery, onSessionAssigned) =>
                handleSend(text, images, context, false, onDelivery, onSessionAssigned)
              }
              onStop={handleStop}
              onInterrupt={localBound ? undefined : handleInterrupt}
              running={repositoryHandoff.present ? false : messages.running}
              initialText={initialPrompt}
              draftControl={
                repositoryHandoff.present || roleIntent ? repositoryDraftControl : undefined
              }
              draftStorageKey={
                repositoryHandoff.present
                  ? repositoryPromptDraftKey(repositoryHandoff.id ?? '')
                  : launch?.draftId
                    ? chatDraftTextKey(launch.draftId)
                    : newChatDraft.missing
                      ? chatDraftStorageKey(newChatDraft.draft.id)
                      : undefined
              }
              sendDisabledReason={
                (invalidRoleSetup
                  ? 'This work conversation setup is unavailable. Return to the work item and choose a supported role.'
                  : roleIntent
                    ? 'Open the bound work chat before sending a message.'
                    : undefined) ??
                builderSourceReason ??
                localRuntime.reason ??
                (controlsBlocked ? 'Loading conversation settings…' : undefined) ??
                (localRuntime.continuation && localCommand && localCommand.state !== 'consumed'
                  ? 'Review the retained Local command before sending.'
                  : undefined) ??
                (explicitNew && localCommand && localCommand.state !== 'consumed'
                  ? 'Review the retained Local command before sending.'
                  : undefined) ??
                (localFirstCommand && (!localTransportAvailable || !connected)
                  ? 'Execution connection is unavailable. Reconnect before sending.'
                  : undefined) ??
                (localFirstCommand && !repositorySelection?.repositoryWorkspaceId
                  ? 'Prepare a repository before sending the command.'
                  : undefined) ??
                (launchDeliveryPending
                  ? 'Waiting for this launch’s delivery confirmation. Its draft is retained.'
                  : undefined) ??
                (launchAccountError || undefined) ??
                missingDraftReason ??
                repositoryAccountReason ??
                (launch?.briefing
                  ? 'Send the reviewed briefing prompt first, then ask a follow-up.'
                  : undefined) ??
                repositoryHandoffReason ??
                (!activeSessionId && !explicitNew ? agentProfileBlocked : undefined) ??
                (!activeSessionId && repositorySelection?.blocked
                  ? 'Prepare or remove the repository before sending.'
                  : !activeSessionId && !accountSelection
                    ? 'Select an account before sending.'
                    : undefined)
              }
              voice={voice}
              branch={messages.branch || undefined}
              isolation={isolation}
              onIsolationChange={!activeSessionId && !explicitNew ? setIsolation : undefined}
              isWorktree={messages.isWorktree}
              wtId={messages.wtId || undefined}
              sessionId={repositoryHandoff.present ? undefined : (activeSessionId ?? undefined)}
              tokenState={tokens}
              messages={sessionId && sessionId !== activeSessionId ? [] : messages.messages}
              current={sessionId && sessionId !== activeSessionId ? null : messages.current}
              bootContext={bootContext}
              sessionContext={sessionContext}
            />
          </div>
        }
      />
    </div>
  );
}
