import { SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
import type { SessionRuntimeBindingV1 } from '@mitzo/protocol';
import type { Account, AccountSelection } from '../components/AccountModelPicker';
import { pickerModels } from './model-visibility';

const KEY = 'mitzo-default-account-model';
export function getDefaultAccountModel(): AccountSelection | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (typeof value?.accountId !== 'string' || typeof value?.model !== 'string') return null;
    return {
      accountId: value.accountId,
      model: value.model,
      ...(typeof value.reasoningEffort === 'string' || value.reasoningEffort === null
        ? { reasoningEffort: value.reasoningEffort }
        : {}),
    };
  } catch {
    return null;
  }
}
/** Public routing identity only; preferences never grant dispatch authority. */
export function getDefaultAccountReference(): SessionRuntimeBindingV1['account'] | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    const parsed = SessionRuntimeBindingV1Schema.shape.account.safeParse(value?.accountReference);
    return parsed.success && parsed.data.accountId === value?.accountId ? parsed.data : null;
  } catch {
    return null;
  }
}
export function rememberDefaultAccountReference(
  reference: SessionRuntimeBindingV1['account'],
): void {
  const selection = getDefaultAccountModel();
  if (selection?.accountId === reference.accountId) setDefaultAccountModel(selection, reference);
}
export function setDefaultAccountModel(
  selection: AccountSelection | null,
  reference?: SessionRuntimeBindingV1['account'] | null,
): void {
  try {
    const identity = reference === undefined ? getDefaultAccountReference() : reference;
    const parsed = SessionRuntimeBindingV1Schema.shape.account.safeParse(identity);
    if (selection)
      localStorage.setItem(
        KEY,
        JSON.stringify({
          ...selection,
          ...(parsed.success && parsed.data.accountId === selection.accountId
            ? { accountReference: parsed.data }
            : {}),
        }),
      );
    else localStorage.removeItem(KEY);
  } catch {
    /* Browser preferences are optional. */
  }
}

const ACCOUNT_SETTINGS_KEY = 'mitzo-account-model-settings';

/** Only explicit edits update these hints; restored/locked intent stays authoritative. */
export function rememberAccountModel(selection: AccountSelection, account: Account): void {
  const model = account.models.find((entry) => entry.id === selection.model);
  if (
    selection.accountId !== account.id ||
    !model ||
    (selection.reasoningEffort && !model.reasoningEfforts?.includes(selection.reasoningEffort))
  )
    return;
  try {
    const saved = JSON.parse(localStorage.getItem(ACCOUNT_SETTINGS_KEY) || '{}');
    localStorage.setItem(
      ACCOUNT_SETTINGS_KEY,
      JSON.stringify({ ...saved, [account.id]: selection }),
    );
  } catch {
    // Optional browser preference: the current draft still owns the selected settings.
  }
}

export function withAccountThinking(
  selection: AccountSelection,
  account: Account,
): AccountSelection {
  const model = account.models.find((entry) => entry.id === selection.model);
  const effort =
    selection.reasoningEffort === null
      ? null
      : model?.reasoningEfforts?.includes(selection.reasoningEffort ?? '')
        ? selection.reasoningEffort
        : model?.defaultReasoningEffort;
  return {
    accountId: selection.accountId,
    model: selection.model,
    ...(effort === null
      ? { reasoningEffort: null }
      : effort && model?.reasoningEfforts?.includes(effort)
        ? { reasoningEffort: effort }
        : {}),
  };
}

/** A user-selected account starts with its own settings, never another account's model. */
export function accountModelPreference(account: Account): AccountSelection {
  const models = pickerModels(
    account.id,
    account.models.length ? account.models : (account.configuredModels ?? []),
  );
  let saved: AccountSelection | null = null;
  try {
    const value = JSON.parse(localStorage.getItem(ACCOUNT_SETTINGS_KEY) || '{}')?.[account.id];
    if (
      value?.accountId === account.id &&
      typeof value.model === 'string' &&
      (value.reasoningEffort == null || typeof value.reasoningEffort === 'string')
    )
      saved = value;
  } catch {
    // Missing/corrupt optional preferences fall back to this account's catalog.
  }
  const globalDefault = getDefaultAccountModel();
  saved ??= globalDefault?.accountId === account.id ? globalDefault : null;
  return withAccountThinking(
    saved && models.some((model) => model.id === saved!.model)
      ? saved
      : { accountId: account.id, model: models[0]?.id ?? '' },
    { ...account, models },
  );
}
