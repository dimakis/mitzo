import { apiFetch } from './api-fetch';

/** MIME types for common file extensions. Falls back to application/octet-stream. */
function mimeFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    csv: 'text/csv',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Extract just the filename from an absolute or relative path. */
function filenameFromPath(filePath: string): string {
  return filePath.split('/').pop() ?? 'file';
}

/** Download file bytes from the server. */
async function fetchFileBlob(filePath: string): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetch(`/api/files/download?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Download failed' }));
    throw new Error(body.error ?? `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const filename = filenameFromPath(filePath);
  return { blob, filename };
}

/** Check whether the browser supports sharing a file with the given MIME type. */
function canNativeShare(filename: string, blob: Blob): boolean {
  if (typeof navigator.canShare !== 'function') return false;
  const file = new File([blob], filename, { type: blob.type });
  return navigator.canShare({ files: [file] });
}

/**
 * Share or download a file from the workspace.
 *
 * - On mobile (Web Share API available): opens the native share sheet.
 * - On desktop (fallback): triggers a browser download.
 *
 * Returns true if the share/download was initiated successfully.
 */
export async function shareFile(filePath: string): Promise<boolean> {
  const { blob, filename } = await fetchFileBlob(filePath);

  // Re-type the blob with a proper MIME if the server sent application/octet-stream
  const mime = blob.type === 'application/octet-stream' ? mimeFromExt(filename) : blob.type;
  const typedBlob = mime !== blob.type ? new Blob([blob], { type: mime }) : blob;

  // Try native share (mobile)
  if (canNativeShare(filename, typedBlob)) {
    const file = new File([typedBlob], filename, { type: mime });
    await navigator.share({ files: [file] });
    return true;
  }

  // Fallback: browser download
  const url = URL.createObjectURL(typedBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
