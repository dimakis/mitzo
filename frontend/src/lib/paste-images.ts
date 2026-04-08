/**
 * Extract image Files from a paste event's DataTransferItemList.
 * Used by ChatInput to support clipboard paste (iOS keyboard, desktop Cmd+V).
 */
export function extractImageFiles(items: DataTransferItemList, maxCount?: number): File[] {
  const files: File[] = [];
  // When maxCount is 0, no files are extracted (0 means "none", not "unlimited").
  // Omit maxCount or pass undefined for no limit.
  const limit = maxCount ?? items.length;

  for (let i = 0; i < items.length && files.length < limit; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  return files;
}
