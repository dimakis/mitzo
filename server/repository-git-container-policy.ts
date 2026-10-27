/** Opaque Git pack containers have a separate bound from tracked files and
 * administration metadata. Callers must still enforce their aggregate bound. */
export function repositoryGitEntrySizeLimit(path: string): number {
  return /^objects\/pack\/pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx)$/.test(path)
    ? 128 * 1024 * 1024
    : 16 * 1024 * 1024;
}
/** Only the owner of a NEW acquisition store may apply this while its fixed Git
 * fetch is running. Temporary containers are never publication manifest entries. */
export function acquisitionGitEntrySizeLimit(path: string, fetching: boolean): number {
  return fetching && /^objects\/pack\/tmp_pack_[A-Za-z0-9]+$/.test(path)
    ? 128 * 1024 * 1024
    : repositoryGitEntrySizeLimit(path);
}
