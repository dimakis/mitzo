import { z } from 'zod';
import type { TodoOutput } from '../types/todo';
const fields = ['savedArtifact', 'savedRevision', 'savedHash'] as const;
const selector = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  revision: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .transform(Number)
    .pipe(z.number().int().positive().safe()),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SavedArtifactLocation = { id: string; revision: number; sha256: string };
export function readSavedArtifactLocation(
  search: string,
): SavedArtifactLocation | null | 'invalid' {
  const params = new URLSearchParams(search);
  if (fields.every((key) => !params.has(key))) return null;
  if (fields.some((key) => params.getAll(key).length !== 1)) return 'invalid';
  const result = selector.safeParse({
    id: params.get('savedArtifact'),
    revision: params.get('savedRevision'),
    sha256: params.get('savedHash'),
  });
  return result.success ? result.data : 'invalid';
}
export function savedArtifactLocationUrl(
  current: string,
  artifact: Pick<TodoOutput, 'id' | 'revision' | 'sha256'>,
): string {
  const pin = selector.parse({
    id: artifact.id,
    revision: String(artifact.revision),
    sha256: artifact.sha256,
  });
  const url = new URL(current, 'http://local.invalid');
  url.searchParams.set(fields[0], pin.id);
  url.searchParams.set(fields[1], String(pin.revision));
  url.searchParams.set(fields[2], pin.sha256);
  return url.pathname + url.search;
}
export function withoutSavedArtifactLocation(current: string): string {
  const url = new URL(current, 'http://local.invalid');
  for (const key of fields) url.searchParams.delete(key);
  return url.pathname + url.search;
}
