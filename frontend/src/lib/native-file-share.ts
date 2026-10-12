import { registerPlugin } from '@capacitor/core';

const FileShareBridge = registerPlugin<{
  share(options: { filename: string; base64: string }): Promise<{ completed: boolean }>;
}>('FileShareBridge');

/** iOS receives bytes, not a capacitor://, blob:, or authenticated download URL. */
export async function shareNativeFile(file: File): Promise<boolean> {
  if (file.size > 32 * 1024 * 1024) throw new Error('This file is too large to share in the app.');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not prepare this file for sharing.'));
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : '';
      const separator = data.indexOf(',');
      if (separator < 0) reject(new Error('Could not prepare this file for sharing.'));
      else resolve(data.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
  const result = await FileShareBridge.share({ filename: file.name, base64 });
  return result.completed;
}
