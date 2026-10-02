import { Capacitor } from '@capacitor/core';
import { apiFetch } from './api-fetch';
import { artifactApiUrl } from './file-paths';

/** MIME types for common file extensions. Falls back to application/octet-stream. */
function mimeFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown',
    mdx: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
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
async function fetchFileBlob(
  filePath: string,
  sessionId?: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetch(artifactApiUrl('download', filePath, sessionId));
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Download failed' }));
    throw new Error(body.error ?? `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const filename = filenameFromPath(filePath);
  return { blob, filename };
}

/** Prefer the extension for known types; servers may serve Markdown as plain text. */
async function fetchFile(filePath: string, sessionId?: string): Promise<File> {
  const { blob, filename } = await fetchFileBlob(filePath, sessionId);
  const extensionMime = mimeFromExt(filename);
  const mime =
    extensionMime !== 'application/octet-stream' ? extensionMime : blob.type || extensionMime;
  return new File([blob], filename, { type: mime });
}

function saveBrowserFile(file: File): boolean {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  try {
    document.body.appendChild(a);
    a.click();
  } finally {
    document.body.removeChild(a);
    // Keep bytes available until the browser has consumed the download URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
}

/** Explicit download never attempts the system share sheet. */
export async function downloadFile(filePath: string, sessionId?: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    throw new Error('Open this file in a browser to download, or use Share to save it.');
  }
  return saveBrowserFile(await fetchFile(filePath, sessionId));
}

// Keep at most one prepared file briefly so a second tap can share synchronously
// if fetching the bytes outlasted the browser's transient user activation.
let retry: { key: string; file: File; expires: number } | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let operationGeneration = 0;

/** Returns false on cancellation; true means the share/download was initiated. */
export async function shareFile(filePath: string, sessionId?: string): Promise<boolean> {
  const generation = ++operationGeneration;
  clearTimeout(retryTimer);
  const key = JSON.stringify([filePath, sessionId]);
  let file: File;
  if (retry?.key === key && retry.expires > Date.now()) {
    file = retry.file;
  } else {
    retry = undefined;
    file = await fetchFile(filePath, sessionId);
    // Navigation may start another file while these bytes are downloading.
    if (generation !== operationGeneration) return false;
  }

  if (
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    retry = undefined;
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if ((err instanceof DOMException || err instanceof Error) && err.name === 'AbortError')
        return false;
      if ((err instanceof DOMException || err instanceof Error) && err.name === 'NotAllowedError') {
        if (generation === operationGeneration) {
          clearTimeout(retryTimer);
          const prepared = { key, file, expires: Date.now() + 60_000 };
          retry = prepared;
          retryTimer = setTimeout(() => {
            if (retry === prepared) retry = undefined;
          }, 60_000);
        }
        throw new Error('Tap Share again to open the share sheet.', { cause: err });
      }
      throw err;
    }
    return true;
  }

  if (Capacitor.isNativePlatform()) {
    throw new Error('This device cannot share this file type. Open it in a browser to download.');
  }
  return saveBrowserFile(file);
}
