import type { AccountSelection } from '../components/AccountModelPicker';

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
export function setDefaultAccountModel(selection: AccountSelection | null): void {
  try {
    if (selection) localStorage.setItem(KEY, JSON.stringify(selection));
    else localStorage.removeItem(KEY);
  } catch {
    /* Browser preferences are optional. */
  }
}
