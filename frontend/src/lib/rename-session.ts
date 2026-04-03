export async function renameSession(sessionId: string, title: string): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/rename`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Rename failed' }));
    throw new Error(data.error || 'Rename failed');
  }
}
