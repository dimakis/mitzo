import { SessionRuntimeBindingV1Schema } from '@mitzo/protocol';
import type { SessionRuntimeBindingV1 } from '@mitzo/protocol';
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
