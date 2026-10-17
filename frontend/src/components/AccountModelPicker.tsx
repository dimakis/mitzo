import { getDefaultAccountModel, setDefaultAccountModel } from '../lib/account-preference';
import { SymposiumPersonalConnections } from './SymposiumPersonalConnections';
import { AdviserSubscriptions } from './AdviserSubscriptions';
import { UiIcon } from './UiIcon';
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import type { WorkspaceSummary } from '../types/workspace';
import { subscribeSymposiumAccountCatalog } from '../lib/symposium-account-catalog';
import { useQuickSettings, type SettingsPage } from '../lib/quick-settings-context';
import {
  QuickSettingsChoices,
  QuickSettingsField,
  QuickSettingsSupplement,
} from './QuickChatSettings';
import { ModelBrandMark } from './SettingsBrandMark';

import type { AccountSelection } from '../types/account-selection';
export type { AccountSelection } from '../types/account-selection';
export interface Account {
  id: string;
  label: string;
  modelDiscovery?: { stale: boolean };
  models: {
    id: string;
    label: string;
    reasoningEfforts?: string[];
    defaultReasoningEffort?: string;
  }[];
}
const modelsSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      reasoningEfforts: z.array(z.string()).optional(),
      defaultReasoningEffort: z.string().optional(),
    }),
  )
  .min(1);
const catalogSchema = z.array(
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    modelDiscovery: z.object({ stale: z.boolean() }).optional(),
    models: modelsSchema,
  }),
);

function withThinking(selection: AccountSelection, account: Account): AccountSelection {
  const model = account.models.find((m) => m.id === selection.model);
  if (selection.reasoningEffort === null) return selection;
  const effort = model?.reasoningEfforts?.includes(selection.reasoningEffort ?? '')
    ? selection.reasoningEffort
    : model?.defaultReasoningEffort;
  return {
    accountId: selection.accountId,
    model: selection.model,
    ...(effort && model?.reasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}),
  };
}

/** Visible form labels belong to staged dialogs; inline chat controls keep their geometry. */
function PickerField({
  label,
  visible,
  children,
  quick,
}: {
  label: string;
  visible: boolean;
  children: ReactNode;
  quick?: {
    page: SettingsPage;
    value: string;
    selected: string;
    choices: { id: string; label: string; disabled?: boolean }[];
    disabled?: boolean;
    onChange(value: string): void;
  };
}) {
  const navigation = useQuickSettings();
  if (navigation && quick) {
    const title = quick.page === 'thinking' ? 'Thinking' : label;
    return (
      <QuickSettingsField
        page={quick.page}
        title={title}
        value={quick.value}
        selected={quick.selected}
        readOnly={quick.disabled}
        mark={
          quick.page === 'model' ? (
            <ModelBrandMark model={quick.selected} label={quick.value} />
          ) : undefined
        }
      >
        <QuickSettingsChoices
          title={label}
          value={quick.selected}
          choices={quick.choices}
          disabled={quick.disabled}
          onChange={quick.onChange}
        />
      </QuickSettingsField>
    );
  }
  return visible ? (
    <label className="account-model-field">
      <span>{label}</span>
      {children}
    </label>
  ) : (
    <>{children}</>
  );
}

function PickerOptions({
  collapsible,
  children,
  saved = false,
}: {
  collapsible: boolean;
  children: ReactNode;
  saved?: boolean;
}) {
  const navigation = useQuickSettings();
  if (navigation && collapsible)
    return (
      <QuickSettingsField
        page="defaults"
        title="New-chat defaults"
        value={saved ? 'Saved' : 'Not set'}
      >
        {children}
      </QuickSettingsField>
    );
  return collapsible ? (
    <details className="chat-settings-advanced">
      <summary>
        <span>Account options</span>
        <UiIcon name="down" size={16} />
      </summary>
      <div className="account-model-settings-utilities">{children}</div>
    </details>
  ) : (
    <>{children}</>
  );
}

function pickerStatus(quick: boolean, value: string, children: ReactNode) {
  return quick ? (
    <QuickSettingsField page="account" title="Account" value={value}>
      {children}
    </QuickSettingsField>
  ) : (
    children
  );
}

/** Catalog refreshes and draft confirmation belong to one conversation. */
export function AccountModelPicker(
  props: Parameters<typeof SessionAccountModelPicker>[0] & {
    lockAccount?: boolean;
    controlled?: {
      accounts: Account[];
      selection: AccountSelection | null;
      onChange(selection: AccountSelection): void;
      onAccountChange?(selection: AccountSelection): void;
      accountNeedsConfirmation?: boolean;
      onRefresh?(): void;
    };
  },
) {
  if (props.controlled)
    return (
      <ControlledAccountModelPicker
        {...props.controlled}
        disabled={props.disabled}
        lockAccountModel={props.lockAccountModel}
        lockAccount={props.lockAccount}
        presentation={props.presentation}
        canSaveDefault={!props.sessionId && !props.lockAccountModel && !props.lockAccount}
      />
    );
  const sessionKey = `${props.scope === 'symposium' ? 'symposium' : props.scope === 'adviser' ? 'adviser' : (props.sessionId ?? 'new-chat')}:${props.requiredSelection?.accountId ?? ''}:${props.requiredSelection?.model ?? ''}:${JSON.stringify(props.allowedAccountIds?.slice().sort() ?? null)}`;
  return <SessionAccountModelPicker key={sessionKey} {...props} />;
}

function SessionAccountModelPicker({
  sessionId: requestedSessionId,
  preferredModel,
  onChange,
  onSessionHydrated,
  onUnavailable,
  onSummaryChange,
  disabled = false,
  scope = 'chat',
  requireExplicitSelection = false,
  requiredSelection,
  draftOnly = false,
  preferWorkOpenAI = false,
  initialSelection,
  lockAccountModel = false,
  onDraftSelectionChange,
  allowedAccountIds,
  presentation = 'default',
}: {
  presentation?: 'default' | 'settings';
  draftOnly?: boolean;
  preferWorkOpenAI?: boolean;
  initialSelection?: AccountSelection;
  /** Prepared repository sources retain their exact binding until explicitly removed. */
  lockAccountModel?: boolean;
  /** Host-verified routes for this action; undefined preserves ordinary chat's full catalog. */
  allowedAccountIds?: string[];
  scope?: 'chat' | 'symposium' | 'adviser';
  requireExplicitSelection?: boolean;
  requiredSelection?: { accountId: string; model: string };
  disabled?: boolean;
  sessionId: string | null;
  preferredModel: string;
  onChange: (selection: AccountSelection | null) => void;
  /** Persisted session metadata is hydration, independent of editable controls. */
  onSessionHydrated?: (selection: AccountSelection, sessionId: string) => void;
  onUnavailable?: () => void;
  /** Editable controls may have a choice before explicit send confirmation. */
  onDraftSelectionChange?: (selection: AccountSelection) => void;
  onSummaryChange?: (summary: WorkspaceSummary | null) => void;
}) {
  const quick = useQuickSettings();
  const status = (value: string, children: ReactNode) =>
    pickerStatus(!!quick && presentation === 'settings', value, children);
  const sessionId = scope === 'chat' ? requestedSessionId : null;
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [savedDefault, setSavedDefault] = useState(getDefaultAccountModel);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selection, setSelection] = useState<AccountSelection | null>(null);
  const selectionRef = useRef(selection);
  if (selection) selectionRef.current = selection;
  const [bindingLabel, setBindingLabel] = useState('');
  const [fixedSummary, setFixedSummary] = useState<WorkspaceSummary | null>(null);
  const [editingAlias, setEditingAlias] = useState(false);
  const [alias, setAlias] = useState('');
  const [aliasError, setAliasError] = useState('');
  const [savingAlias, setSavingAlias] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (scope === 'symposium')
      return subscribeSymposiumAccountCatalog(() => setAttempt((value) => value + 1));
  }, [scope]);
  const explicitSelection = requireExplicitSelection || (scope === 'symposium' && attempt > 0);
  const [personalAccountsOpen, setPersonalAccountsOpen] = useState(false);
  const [legacyRequested, setLegacy] = useState(false);
  const legacy = scope === 'chat' && legacyRequested;
  const [fixedSession, setFixedSession] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  const callbacks = useRef({
    onChange,
    onSessionHydrated,
    onUnavailable,
    onSummaryChange,
    onDraftSelectionChange,
  });
  callbacks.current = {
    onChange,
    onSessionHydrated,
    onUnavailable,
    onSummaryChange,
    onDraftSelectionChange,
  };
  useEffect(() => {
    if (selection) callbacks.current.onDraftSelectionChange?.(selection);
  }, [selection]);
  const summaryAccount = accounts.find((a) => a.id === (selection?.accountId ?? ''));
  const selectedModel = summaryAccount?.models.find((m) => m.id === selection?.model);
  const defaultThinking = scope === 'adviser' ? 'adviser default' : 'model default';
  const summary: WorkspaceSummary | null = error
    ? { profile: 'Profile unavailable' }
    : empty
      ? { profile: 'No profiles configured' }
      : summaryAccount && selection
        ? {
            sessionType: scope === 'chat' ? 'chat' : 'symposium',
            profile: summaryAccount.label,
            model: selectedModel?.label ?? selection.model,
            thinking:
              selection.reasoningEffort !== undefined
                ? `Thinking: ${selection.reasoningEffort ?? defaultThinking}`
                : selectedModel
                  ? selectedModel.reasoningEfforts?.length
                    ? `Thinking: ${defaultThinking}`
                    : 'Thinking: not configurable'
                  : 'Thinking: unknown',
          }
        : fixedSummary;
  const profile = summary?.profile;
  const model = summary?.model;
  const thinking = summary?.thinking;
  const sessionType = summary?.sessionType;
  useEffect(() => {
    callbacks.current.onSummaryChange?.(profile ? { profile, model, thinking, sessionType } : null);
  }, [profile, model, thinking, sessionType]);
  useEffect(() => {
    if (error || empty) onUnavailable?.();
  }, [error, empty, onUnavailable]);
  useEffect(() => {
    let disposed = false;
    setError('');
    setEditingAlias(false);
    setBindingLabel('');
    setFixedSummary(null);
    setAccounts([]);
    callbacks.current.onSummaryChange?.(null);
    setFixedSession(false);
    setSelection(null);
    setEmpty(false);
    setDraftUnavailable(false);
    callbacks.current.onChange(null);
    const baseUrl =
      scope === 'adviser'
        ? '/api/terminals/accounts'
        : scope === 'symposium'
          ? '/api/symposium/accounts'
          : sessionId
            ? `/api/sessions/${encodeURIComponent(sessionId)}/meta`
            : legacy
              ? '/api/models'
              : '/api/accounts';
    const url = baseUrl + (attempt && scope === 'chat' ? '?refresh=1' : '');
    const controller = new AbortController();
    async function fetchMetadata() {
      const retryDelays = [100, 200, 400];
      for (let retry = 0; ; retry++) {
        const response = await apiFetch(url, { signal: controller.signal });
        if (!sessionId || response.status !== 404 || retry >= retryDelays.length || disposed)
          return response;
        // Accepted sessions can arrive before provider startup persists their metadata.
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, retryDelays[retry]);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
        if (disposed) return response;
      }
    }
    void fetchMetadata()
      .then(async (response) => {
        if (sessionId && response.status === 404) {
          if (!disposed) {
            setBindingLabel('Existing task · legacy account');
            setFixedSummary({
              sessionType: 'chat',
              profile: 'Legacy account',
              model: 'Model unknown',
              thinking: 'Thinking: unknown',
            });
            setFixedSession(true);
            callbacks.current.onChange({ model: preferredModel });
          }
          return;
        }
        if (!response.ok)
          throw new Error(
            scope === 'symposium'
              ? 'Symposium account catalog unavailable. Retry to continue.'
              : 'Account information unavailable. Retry to continue.',
          );
        const data = await response.json();
        if (disposed) return;
        if (sessionId && data.sessionType === 'symposium') {
          setBindingLabel('Choose an agent stream to write to that agent.');
          setFixedSummary({
            sessionType: 'symposium',
            profile: 'Symposium',
            model: 'Accounts and models per agent',
          });
          setFixedSession(true);
          return;
        }
        if (sessionId) {
          const modelSelection = z
            .object({
              model: z.string(),
              models: modelsSchema,
              reasoningEffort: z.string().nullable().optional(),
            })
            .safeParse(data.modelSelection);
          if (data.accountBinding && modelSelection.success) {
            const account = {
              id: data.accountBinding.accountId,
              label: data.accountBinding.accountLabel,
              models: modelSelection.data.models,
            };
            setAccounts([account]);
            const next = withThinking(
              {
                accountId: account.id,
                model: modelSelection.data.model,
                reasoningEffort: modelSelection.data.reasoningEffort,
              },
              account,
            );
            // Persisted session settings are authoritative even when catalog capabilities are missing.
            if (modelSelection.data.reasoningEffort !== undefined)
              next.reasoningEffort = modelSelection.data.reasoningEffort;
            setSelection(next);
            if (callbacks.current.onSessionHydrated)
              callbacks.current.onSessionHydrated(next, sessionId);
            else callbacks.current.onChange(explicitSelection ? null : next);
          } else {
            const next = data.accountBinding
              ? { accountId: data.accountBinding.accountId, model: data.accountBinding.model }
              : { model: preferredModel };
            setFixedSession(true);
            setFixedSummary({
              sessionType: 'chat',
              profile: data.accountBinding?.accountLabel ?? 'Legacy account',
              model: 'Model unknown',
              thinking: 'Thinking: unknown',
            });
            if (
              callbacks.current.onSessionHydrated &&
              typeof next.accountId === 'string' &&
              next.accountId &&
              next.model
            )
              callbacks.current.onSessionHydrated(next, sessionId);
            else callbacks.current.onChange(explicitSelection ? null : next);
          }
          setBindingLabel(
            data.accountBinding
              ? data.accountBinding.accountLabel
              : 'Existing task · legacy account',
          );
        } else {
          const parsed = legacy
            ? modelsSchema
                .transform((models) => [{ id: '', label: 'Legacy server account', models }])
                .safeParse(data)
            : catalogSchema.safeParse(data);
          if (!parsed.success)
            throw new Error(
              'Invalid account information. Retry or check the server configuration.',
            );
          const catalog: Account[] = allowedAccountIds
            ? parsed.data.filter((account) => allowedAccountIds.includes(account.id))
            : parsed.data;
          if (!catalog.length) {
            setEmpty(true);
            return;
          }
          setAccounts(catalog);
          if (requiredSelection) {
            const account = catalog.find((entry) => entry.id === requiredSelection.accountId);
            if (
              !account ||
              account.modelDiscovery?.stale ||
              !account.models.some((entry) => entry.id === requiredSelection.model)
            )
              throw new Error(
                'Prepared account or model is unavailable. Refresh accounts before sending.',
              );
            const next = withThinking(requiredSelection, account);
            setSelection(next);
            setNeedsConfirmation(false);
            callbacks.current.onChange(next);
            return;
          }
          const deviceDefault = scope === 'chat' && !legacy ? getDefaultAccountModel() : null;
          const eligibleDefault =
            !allowedAccountIds || allowedAccountIds.includes(deviceDefault?.accountId ?? '')
              ? deviceDefault
              : null;
          const previous =
            (attempt ? selectionRef.current : null) ?? initialSelection ?? eligibleDefault;
          if (
            !legacy &&
            previous &&
            !catalog.some(
              (a) => a.id === previous.accountId && a.models.some((m) => m.id === previous.model),
            )
          ) {
            setSelection(previous);
            setDraftUnavailable(true);
            callbacks.current.onUnavailable?.();
            return;
          }
          const first =
            catalog.find((a) => a.id === previous?.accountId) ??
            (preferWorkOpenAI
              ? catalog.find((a) => /\bwork\b/i.test(a.label) && /openai/i.test(a.label))
              : undefined) ??
            catalog[0];
          const next = {
            ...(!legacy ? { accountId: first.id } : {}),
            model: first.models.some((m) => m.id === (previous?.model ?? preferredModel))
              ? (previous?.model ?? preferredModel)
              : first.models[0].id,
          };
          const selected = withThinking(
            { ...next, reasoningEffort: previous?.reasoningEffort },
            first,
          );
          const confirm =
            !draftOnly && scope === 'chat' && !legacy && (!previous || needsConfirmation);
          setNeedsConfirmation(confirm);
          setDraftUnavailable(false);
          setSelection(selected);
          callbacks.current.onChange(explicitSelection || confirm ? null : selected);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Account information unavailable.');
        }
      });
    return () => {
      disposed = true;
      controller.abort();
    };
    // Preferred model is read only when a new task opens; changing it must not reload the catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    attempt,
    legacy,
    scope,
    requireExplicitSelection,
    requiredSelection?.accountId,
    requiredSelection?.model,
  ]);
  const subscriptionLogin =
    scope === 'symposium' ? (
      <>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={personalAccountsOpen}
          onClick={() => setPersonalAccountsOpen((open) => !open)}
        >
          Manage personal ChatGPT accounts
        </button>
        {personalAccountsOpen && <SymposiumPersonalConnections disabled={disabled} />}
      </>
    ) : scope === 'adviser' ? (
      <AdviserSubscriptions
        disabled={disabled}
        onAccountsChanged={() => setAttempt((value) => value + 1)}
      />
    ) : null;
  if (error)
    return status(
      'Unavailable',
      <>
        {subscriptionLogin}
        <span role="alert">{error}</span>
        <button disabled={disabled} onClick={() => setAttempt((value) => value + 1)}>
          Retry accounts
        </button>
        {scope === 'chat' &&
          !sessionId &&
          !legacy &&
          !requiredSelection &&
          !lockAccountModel &&
          !draftOnly && (
            <button disabled={disabled} onClick={() => setLegacy(true)}>
              Use legacy server account
            </button>
          )}
      </>,
    );
  if (sessionId && fixedSession)
    return status(
      bindingLabel || 'Unavailable',
      <>
        <span className="chat-account-binding">{bindingLabel}</span>
      </>,
    );
  if (sessionId && !selection)
    return status(
      bindingLabel || 'Loading…',
      <>
        <span className="chat-account-binding">{bindingLabel || 'Loading account…'}</span>
      </>,
    );
  if (empty)
    return status(
      'No accounts configured',
      <>
        {subscriptionLogin}
        <span>
          {allowedAccountIds
            ? 'No accounts are eligible for this action.'
            : scope === 'symposium'
              ? 'No Symposium account profiles configured.'
              : 'No account profiles configured.'}
        </span>
        {scope === 'chat' && !requiredSelection && !draftOnly && !allowedAccountIds && (
          <button disabled={disabled} onClick={() => setLegacy(true)}>
            Use legacy server account
          </button>
        )}
      </>,
    );
  if (!selection)
    return status(
      'Loading…',
      <>
        {subscriptionLogin}
        <span>Loading accounts…</span>
      </>,
    );
  const account =
    accounts.find((a) => a.id === (selection.accountId ?? '')) ??
    (draftUnavailable
      ? { id: selection.accountId ?? '', label: 'Unavailable account', models: [] }
      : undefined);
  if (!account) return <span role="alert">Selected account is unavailable. Reopen the task.</span>;
  const changeAccount = (id: string) => {
    const nextAccount = accounts.find((a) => a.id === id);
    if (!nextAccount || disabled || requiredSelection || lockAccountModel) return;
    setEditingAlias(false);
    const next = withThinking(
      { accountId: nextAccount.id, model: nextAccount.models[0].id },
      nextAccount,
    );
    setDraftUnavailable(false);
    setNeedsConfirmation(false);
    setSelection(next);
    onChange(explicitSelection ? null : next);
  };
  const changeModel = (id: string) => {
    if (disabled || requiredSelection || lockAccountModel) return;
    const next = withThinking({ accountId: selection.accountId, model: id }, account);
    setDraftUnavailable(false);
    setSelection(next);
    onChange(explicitSelection || needsConfirmation ? null : next);
  };
  const changeThinking = (value: string) => {
    if (disabled) return;
    const next = { ...selection, reasoningEffort: value || null };
    setSelection(next);
    onChange(explicitSelection || needsConfirmation ? null : next);
  };
  const fieldModel = account.models.find((m) => m.id === selection.model);
  const fields = (
    <>
      {subscriptionLogin}
      {draftUnavailable && (
        <span role="alert">
          Selected account or model is unavailable. Choose an account and model explicitly.
        </span>
      )}
      {sessionId ? (
        status(
          account.label,
          <>
            <span className="chat-account-binding">{account.label}</span>
          </>,
        )
      ) : legacy ? (
        status(
          'Legacy server account',
          <>
            <span>Legacy server account</span>
          </>,
        )
      ) : (
        <PickerField
          label="Account"
          visible={draftOnly || presentation === 'settings'}
          quick={
            presentation === 'settings'
              ? {
                  page: 'account',
                  value:
                    explicitSelection || needsConfirmation
                      ? `Confirm ${account.label}`
                      : account.label,
                  selected: account.id,
                  choices: accounts,
                  disabled: disabled || !!requiredSelection || lockAccountModel,
                  onChange: changeAccount,
                }
              : undefined
          }
        >
          <select
            disabled={disabled || !!requiredSelection || lockAccountModel}
            aria-label="Account"
            className="chat-model-select"
            value={account.id}
            onChange={(e) => changeAccount(e.target.value)}
          >
            {!accounts.some((a) => a.id === account.id) && (
              <option value={account.id} disabled>
                {account.label}
              </option>
            )}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </PickerField>
      )}
      {scope === 'chat' && !legacy && !draftOnly && presentation !== 'settings' && (
        <button
          disabled={disabled}
          aria-label="Edit account alias"
          onClick={() => {
            setAlias(account.label);
            setAliasError('');
            setEditingAlias(true);
          }}
        >
          Rename
        </button>
      )}
      {editingAlias && (
        <form
          className="chat-account-alias-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingAlias(true);
            setAliasError('');
            try {
              const response = await apiFetch(
                `/api/accounts/${encodeURIComponent(account.id)}/alias`,
                {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ alias }),
                },
              );
              if (!response.ok) throw new Error('Could not save alias. Retry.');
              const data = z.object({ label: z.string() }).parse(await response.json());
              setAccounts((old) =>
                old.map((a) => (a.id === account.id ? { ...a, label: data.label } : a)),
              );
              setEditingAlias(false);
            } catch {
              setAliasError('Could not save alias. Retry.');
            } finally {
              setSavingAlias(false);
            }
          }}
        >
          <input
            aria-label="Account alias"
            maxLength={80}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={savingAlias}
          />
          <button disabled={savingAlias || disabled} type="submit">
            Save alias
          </button>
          <button type="button" disabled={savingAlias} onClick={() => setEditingAlias(false)}>
            Cancel
          </button>
          {aliasError && <span role="alert">{aliasError}</span>}
        </form>
      )}

      <PickerField
        label="Model"
        visible={draftOnly || presentation === 'settings'}
        quick={
          presentation === 'settings'
            ? {
                page: 'model',
                value: fieldModel?.label ?? `${selection.model} (unavailable)`,
                selected: selection.model,
                choices: fieldModel
                  ? account.models
                  : [
                      {
                        id: selection.model,
                        label: `${selection.model} (unavailable)`,
                        disabled: true,
                      },
                      ...account.models,
                    ],
                disabled: disabled || !!requiredSelection || lockAccountModel,
                onChange: changeModel,
              }
            : undefined
        }
      >
        <select
          disabled={disabled || !!requiredSelection || lockAccountModel}
          aria-label="Model"
          className="chat-model-select"
          value={selection.model}
          onChange={(e) => changeModel(e.target.value)}
        >
          {!account.models.some((m) => m.id === selection.model) && (
            <option value={selection.model} disabled>
              {selection.model} (unavailable)
            </option>
          )}
          {account.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </PickerField>
      {!!account.models.find((m) => m.id === selection.model)?.reasoningEfforts?.length && (
        <PickerField
          label={presentation === 'settings' ? 'Thinking level' : 'Thinking'}
          visible={draftOnly || presentation === 'settings'}
          quick={
            presentation === 'settings'
              ? {
                  page: 'thinking',
                  value: selection.reasoningEffort || 'Model default',
                  selected: selection.reasoningEffort ?? '',
                  choices: [
                    { id: '', label: 'Model default' },
                    ...(fieldModel?.reasoningEfforts ?? []).map((id) => ({ id, label: id })),
                  ],
                  disabled,
                  onChange: changeThinking,
                }
              : undefined
          }
        >
          <select
            aria-label={presentation === 'settings' ? 'Thinking level' : 'Thinking'}
            className="chat-model-select"
            disabled={disabled}
            value={selection.reasoningEffort ?? ''}
            onChange={(e) => changeThinking(e.target.value)}
          >
            <option value="">{scope === 'adviser' ? 'Adviser default' : 'Model default'}</option>
            {account.models
              .find((m) => m.id === selection.model)
              ?.reasoningEfforts?.map((effort) => (
                <option key={effort} value={effort}>
                  Thinking: {effort}
                </option>
              ))}
          </select>
        </PickerField>
      )}

      {account.modelDiscovery?.stale && (
        <span role="status">Model refresh failed. Showing the last available list.</span>
      )}
      <QuickSettingsSupplement page="account">
        {(explicitSelection || needsConfirmation) && (
          <button
            type="button"
            disabled={
              disabled ||
              draftUnavailable ||
              !account.models.some((model) => model.id === selection.model)
            }
            onClick={() => {
              if (
                !draftUnavailable &&
                account.models.some((model) => model.id === selection.model)
              ) {
                setNeedsConfirmation(false);
                onChange(selection);
              }
            }}
          >
            Use {account.label} ·{' '}
            {account.models.find((model) => model.id === selection.model)?.label ?? selection.model}
          </button>
        )}
      </QuickSettingsSupplement>
      {quick && scope === 'chat' && !legacy && (
        <QuickSettingsSupplement page="model">
          <button disabled={disabled} onClick={() => setAttempt((n) => n + 1)}>
            Refresh models
          </button>
        </QuickSettingsSupplement>
      )}
      {scope === 'chat' && !legacy && (
        <PickerOptions collapsible={presentation === 'settings'} saved={!!savedDefault}>
          {!sessionId && !requiredSelection && !lockAccountModel && !draftOnly && (
            <>
              <button
                disabled={disabled || draftUnavailable}
                onClick={() => {
                  setDefaultAccountModel(selection);
                  setSavedDefault(selection);
                }}
              >
                Make default for new chats
              </button>
              {savedDefault && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    setDefaultAccountModel(null);
                    setSavedDefault(null);
                    setNeedsConfirmation(true);
                    onChange(null);
                  }}
                >
                  Clear new-chat default
                </button>
              )}
              <span>
                {savedDefault
                  ? 'Saved default for new chats on this browser.'
                  : 'No saved account default. Review the account before sending.'}
              </span>
            </>
          )}
          <button disabled={disabled} onClick={() => setAttempt((n) => n + 1)}>
            Refresh models
          </button>
        </PickerOptions>
      )}
    </>
  );
  if (presentation !== 'settings') return fields;
  const children = Children.toArray(fields.props.children);
  const modelIndex = children.findIndex(
    (child) =>
      isValidElement<{ label?: string }>(child) &&
      child.type === PickerField &&
      child.props.label === 'Model',
  );
  const thinkingIndex = children.findIndex(
    (child) =>
      isValidElement<{ label?: string }>(child) &&
      child.type === PickerField &&
      child.props.label === 'Thinking level',
  );
  const end = thinkingIndex >= 0 ? thinkingIndex + 1 : modelIndex + 1;
  return (
    <>
      <div className="account-model-settings-account">{children.slice(0, modelIndex)}</div>
      <div className="account-model-settings-pair">{children.slice(modelIndex, end)}</div>
      <div className="account-model-settings-utilities">{children.slice(end)}</div>
    </>
  );
}

/** A bounded chat route keeps invalid intent visible until an explicit edit. */
function ControlledAccountModelPicker({
  accounts,
  selection,
  onChange,
  disabled,
  lockAccountModel,
  lockAccount,
  onAccountChange,
  accountNeedsConfirmation = false,
  onRefresh,
  canSaveDefault = false,
  presentation = 'default',
}: {
  presentation?: 'default' | 'settings';
  accounts: Account[];
  selection: AccountSelection | null;
  onChange(selection: AccountSelection): void;
  onAccountChange?(selection: AccountSelection): void;
  accountNeedsConfirmation?: boolean;
  onRefresh?(): void;
  canSaveDefault?: boolean;
  disabled?: boolean;
  lockAccountModel?: boolean;
  lockAccount?: boolean;
}) {
  const quick = useQuickSettings();
  const [savedDefault, setSavedDefault] = useState(getDefaultAccountModel);
  const account = accounts.find((a) => a.id === selection?.accountId);
  const model = account?.models.find((m) => m.id === selection?.model);
  const pendingAccount = accountNeedsConfirmation && !!account && !lockAccount && !lockAccountModel;
  let pendingAccountValue = '__mitzo_confirm_account__';
  while (accounts.some((entry) => entry.id === pendingAccountValue)) pendingAccountValue += '_';
  const field = (
    identity: 'Account' | 'Model' | 'Thinking',
    value: string,
    entries: { id: string; label: string }[],
    change: (value: string) => void,
    pendingLabel?: string,
  ) => {
    const label =
      identity === 'Thinking' && presentation === 'settings' ? 'Thinking level' : identity;
    return (
      <PickerField
        label={label}
        visible
        quick={
          presentation === 'settings'
            ? {
                page: identity.toLowerCase() as 'account' | 'model' | 'thinking',
                value:
                  pendingLabel ??
                  entries.find((entry) => entry.id === value)?.label ??
                  (value
                    ? `Unavailable: ${value}`
                    : identity === 'Thinking'
                      ? 'Model default'
                      : `Choose ${label.toLowerCase()}`),
                selected: value,
                choices: [
                  {
                    id: '',
                    label:
                      identity === 'Thinking' ? 'Model default' : `Choose ${label.toLowerCase()}`,
                  },
                  ...(!value || entries.some((entry) => entry.id === value)
                    ? []
                    : [
                        {
                          id: value,
                          label: pendingLabel ?? `Unavailable ${label.toLowerCase()}: ${value}`,
                          disabled: true,
                        },
                      ]),
                  ...entries,
                ],
                disabled:
                  disabled ||
                  (identity !== 'Thinking' && lockAccountModel) ||
                  (identity === 'Account' && lockAccount),
                onChange: change,
              }
            : undefined
        }
      >
        <select
          aria-label={label}
          className="chat-model-select"
          disabled={
            disabled ||
            (identity !== 'Thinking' && lockAccountModel) ||
            (identity === 'Account' && lockAccount)
          }
          value={value}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">Choose {label.toLowerCase()}</option>
          {value && !entries.some((e) => e.id === value) && (
            <option disabled value={value}>
              {pendingLabel ?? `Unavailable ${label.toLowerCase()}: ${value}`}
            </option>
          )}
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </PickerField>
    );
  };
  return (
    <>
      {field(
        'Account',
        pendingAccount ? pendingAccountValue : (selection?.accountId ?? ''),
        accounts,
        (id) => {
          if (!id && selection) {
            (onAccountChange ?? onChange)({ ...selection, accountId: undefined });
            return;
          }
          const chosen = accounts.find((a) => a.id === id);
          if (chosen)
            (onAccountChange ?? onChange)({
              accountId: id,
              model: selection?.model ?? chosen.models[0]?.id ?? '',
              reasoningEffort: selection?.reasoningEffort ?? null,
            });
        },
        pendingAccount ? `Confirm account: ${account!.label}` : undefined,
      )}
      {field('Model', selection?.model ?? '', account?.models ?? [], (id) => {
        if (selection && id) onChange({ ...selection, model: id });
      })}
      {field(
        'Thinking',
        selection?.reasoningEffort ?? '',
        model?.reasoningEfforts?.map((id) => ({ id, label: id })) ?? [],
        (effort) => {
          if (selection) onChange({ ...selection, reasoningEffort: effort || null });
        },
      )}
      {quick && presentation === 'settings' && (
        <PickerOptions collapsible saved={!!savedDefault}>
          {canSaveDefault && (
            <>
              <button
                disabled={
                  disabled ||
                  pendingAccount ||
                  !account ||
                  !model ||
                  (!!selection?.reasoningEffort &&
                    !model.reasoningEfforts?.includes(selection.reasoningEffort))
                }
                onClick={() => {
                  if (!selection) return;
                  setDefaultAccountModel(selection);
                  setSavedDefault(selection);
                }}
              >
                Make default for new chats
              </button>
              {savedDefault && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    setDefaultAccountModel(null);
                    setSavedDefault(null);
                  }}
                >
                  Clear new-chat default
                </button>
              )}
            </>
          )}
          <p>
            {savedDefault
              ? 'Saved default for new chats on this browser.'
              : 'No saved account default. Review the account before sending.'}
          </p>
          {onRefresh && (
            <button disabled={disabled} onClick={onRefresh}>
              Refresh models
            </button>
          )}
        </PickerOptions>
      )}
      {quick && onRefresh && (
        <QuickSettingsSupplement page="model">
          <button disabled={disabled} onClick={onRefresh}>
            Refresh models
          </button>
        </QuickSettingsSupplement>
      )}
    </>
  );
}
