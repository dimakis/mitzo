import { z } from 'zod';
import {
  OrdinaryWorkspacePreparationRequestSchema,
  OrdinaryWorkspacePreparationReceiptSchema,
} from '@mitzo/protocol';
const stored = z
  .strictObject({
    version: z.literal(1),
    draftId: z.string().min(1).max(200),
    selectionKey: z.string().min(1).max(32768),
    request: OrdinaryWorkspacePreparationRequestSchema,
    receipt: OrdinaryWorkspacePreparationReceiptSchema,
  })
  .superRefine((value, context) => {
    const { request, receipt } = value;
    if (
      JSON.stringify(request.runtime.account) !== JSON.stringify(receipt.runtimeBinding.account) ||
      request.runOn !== receipt.runtimeBinding.execution.location ||
      request.runtime.targetId !== receipt.runtimeBinding.execution.targetId ||
      request.runtime.harness !== receipt.runtimeBinding.harness.implementation
    )
      context.addIssue({ code: 'custom', message: 'Original ordinary preparation scope required' });
  });
export type RetainedOrdinaryPreparation = z.infer<typeof stored>;
export function validateOrdinaryPreparation(value: RetainedOrdinaryPreparation) {
  return stored.parse(value);
}
const key = (draftId: string) =>
  'mitzo-ordinary-workspace-preparation:' + encodeURIComponent(draftId);
/** Readiness receipt only. Corrupt storage never grants a replacement request. */
export function loadOrdinaryPreparation(draftId: string) {
  const raw = localStorage.getItem(key(draftId));
  if (!raw) return null;
  const value = stored.parse(JSON.parse(raw));
  if (value.draftId !== draftId) throw Error('Original draft required');
  return value;
}
export function retainOrdinaryPreparation(value: RetainedOrdinaryPreparation) {
  value = stored.parse(value);
  const previous = loadOrdinaryPreparation(value.draftId);
  if (
    previous?.selectionKey === value.selectionKey &&
    JSON.stringify(previous) !== JSON.stringify(value)
  )
    throw Error('Original ordinary preparation is already retained');
  const bytes = JSON.stringify(value);
  localStorage.setItem(key(value.draftId), bytes);
  if (localStorage.getItem(key(value.draftId)) !== bytes)
    throw Error('Ordinary preparation could not be retained');
  return value;
}
