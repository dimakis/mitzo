/**
 * Deliberately conservative ASCII email validation for reviewed provider
 * configuration. This is not a mailbox-deliverability check: it rejects
 * malformed values before they enter durable state or a sandbox environment.
 */
const localPart = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const domainLabel = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isValidEmailAddress(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 320 ||
    value !== value.trim() ||
    /[^\x21-\x7e]/.test(value)
  )
    return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at !== value.indexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || domain.length > 255 || !localPart.test(local)) return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) => domainLabel.test(label)) &&
    /^[A-Za-z]{2,63}$/.test(labels.at(-1)!)
  );
}
