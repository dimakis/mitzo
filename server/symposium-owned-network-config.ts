const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Pure configuration predicates; no gateway operations are imported. */
/** Trusted driver selector only; actual network ownership is separately established. */
export function isOwnedSymposiumSupervisorNetwork(value: string, network: string): boolean {
  return (
    typeof value === 'string' &&
    id.test(value) &&
    value === network &&
    !['host', 'none', 'bridge', 'private', 'slirp4netns', 'pasta'].includes(value)
  );
}

/** Shared with private file configuration admission; credentials and bypasses are forbidden. */
export function isOwnedSymposiumProxyUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):([0-9]{1,5})$/.exec(
    value,
  );
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch {
    return false;
  }
}
