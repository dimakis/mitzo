import { z } from 'zod';

/** A closed list, not a generic HTTP/host-command tunnel. Reauthorization and
 * publication prompts stay in the current browser controller; the retained owner requests each exact approval over the inherited channel. */
const operations = {
  'publication.recoveryStatus': ['GET', '/api/sessions/:sessionId/symposium/publication/recovery'],
  'publication.recover': ['POST', '/api/sessions/:sessionId/symposium/publication/recovery'],
  'publication.status': ['GET', '/api/sessions/:sessionId/symposium/publication'],
  'publication.artifact': ['POST', '/api/sessions/:sessionId/symposium/publication/artifact'],
  'publication.select': ['POST', '/api/sessions/:sessionId/symposium/publication/select'],
  'publication.disconnect': ['POST', '/api/sessions/:sessionId/symposium/publication/disconnect'],
  'publication.preview': ['POST', '/api/sessions/:sessionId/symposium/publication/preview'],
  'publication.grant': ['POST', '/api/sessions/:sessionId/symposium/publication/grant'],
  'publication.revoke': ['POST', '/api/sessions/:sessionId/symposium/publication/revoke'],
  'publication.publish': ['POST', '/api/sessions/:sessionId/symposium/publication/publish'],
  'custody.status': ['GET', '/api/symposium/custody'],
  'director.status': ['GET', '/api/sessions/:sessionId/symposium'],
  'director.contextTurns': ['GET', '/api/sessions/:sessionId/symposium/context-turns'],
  'director.contextPackage': ['POST', '/api/sessions/:sessionId/symposium/context-package'],
  'director.perspectives': ['GET', '/api/sessions/:sessionId/symposium/perspectives'],
  'director.reviseSeat': ['POST', '/api/sessions/:sessionId/symposium/seats/revise'],
  'director.activate': ['POST', '/api/sessions/:sessionId/symposium/activate'],
  'director.draft': ['POST', '/api/sessions/:sessionId/symposium/draft'],
  'director.selection': ['POST', '/api/sessions/:sessionId/symposium/selection'],
  'director.config': ['PUT', '/api/sessions/:sessionId/symposium/config'],
  'director.refreshAdmissions': ['POST', '/api/sessions/:sessionId/symposium/admissions/refresh'],
  'director.transferPrimary': ['POST', '/api/sessions/:sessionId/symposium/primary/transfer'],
  'director.authorizeRecovery': [
    'POST',
    '/api/sessions/:sessionId/symposium/creation/recovery/reauthorize',
  ],
  'director.recoverCreation': ['POST', '/api/sessions/:sessionId/symposium/creation/recover'],
  'director.membership': ['POST', '/api/sessions/:sessionId/symposium/membership'],
  'delivery.stage': ['POST', '/api/sessions/:sessionId/symposium/deliveries'],
  'delivery.share': ['POST', '/api/sessions/:sessionId/symposium/share-excerpt'],
  'delivery.intervene': [
    'POST',
    '/api/sessions/:sessionId/symposium/deliveries/:resourceId/interventions',
  ],
  'delivery.dispatch': [
    'POST',
    '/api/sessions/:sessionId/symposium/deliveries/:resourceId/dispatch',
  ],
  'delivery.cancel': ['POST', '/api/sessions/:sessionId/symposium/deliveries/:resourceId/cancel'],
  'session.create': ['POST', '/api/symposium/sessions'],
  'session.artifacts': ['POST', '/api/symposium/sessions/:sessionId/artifacts'],
  'source.status': ['GET', '/api/sessions/:sessionId/symposium/source'],
  'source.preview': ['POST', '/api/sessions/:sessionId/symposium/source/preview'],
  'source.import': ['POST', '/api/sessions/:sessionId/symposium/source/import'],
  'source.sealRecover': ['POST', '/api/sessions/:sessionId/symposium/source/seal/recover'],
  'review.list': ['GET', '/api/sessions/:sessionId/symposium/reviews'],
  'review.startApplication': [
    'POST',
    '/api/sessions/:sessionId/symposium/reviews/application-runs',
  ],
  'review.workflow': ['GET', '/api/sessions/:sessionId/symposium/reviews/:resourceId'],
  'review.action': ['POST', '/api/sessions/:sessionId/symposium/reviews/:resourceId/actions'],
  'review.record': ['GET', '/api/sessions/:sessionId/symposium/reviews/records/:resourceId'],
  'review.publicationPreflight': [
    'POST',
    '/api/sessions/:sessionId/symposium/reviews/records/:resourceId/publication-preflight',
  ],
  'personal.list': ['GET', '/api/symposium/personal/connections'],
  'personal.create': ['POST', '/api/symposium/personal/connections'],
  'personal.disconnect': ['POST', '/api/symposium/personal/connections/:resourceId/disconnect'],
  'personal.refreshModels': [
    'POST',
    '/api/symposium/personal/connections/:resourceId/models/refresh',
  ],
  'personal.recoverModels': [
    'POST',
    '/api/symposium/personal/connections/:resourceId/models/recover',
  ],
  'personal.loginStatus': ['GET', '/api/symposium/personal/login/status'],
  'personal.login': ['POST', '/api/symposium/personal/login'],
  'personal.cancelLogin': ['POST', '/api/symposium/personal/login/cancel'],
  'account.catalog': ['GET', '/api/symposium/accounts'],
  'session.admissionEvidence': ['POST', '/api/symposium/sessions/:sessionId/admission-evidence'],
  'admission.evidence': ['POST', '/api/symposium/admission-evidence'],
  'profile.list': ['GET', '/api/symposium/profiles'],
  'profile.create': ['POST', '/api/symposium/profiles'],
  'profile.import': ['POST', '/api/symposium/profiles/import'],
  'profile.export': ['GET', '/api/symposium/profiles/:resourceId/:revision/export'],
  'profile.read': ['GET', '/api/symposium/profiles/:resourceId/:revision'],
  'proposal.list': ['GET', '/api/symposium/profile-proposals'],
  'proposal.save': ['POST', '/api/symposium/profile-proposals/:resourceId/save'],
  'proposal.discard': ['POST', '/api/symposium/profile-proposals/:resourceId/discard'],
} as const;
export type CustodianOperation = keyof typeof operations;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const selection = z.strictObject({
  operation: z.enum(Object.keys(operations) as [CustodianOperation, ...CustodianOperation[]]),
  sessionId: identifier.optional(),
  resourceId: identifier.optional(),
  revision: z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/)
    .optional(),
});
export type CustodianSelection = z.infer<typeof selection>;
const request = selection.extend({
  requestId: identifier,
  epoch: z.number().int().positive(),
  body: z.record(z.string(), z.unknown()),
  query: z.record(z.string(), z.string()),
  authorization: z.strictObject({
    id: identifier,
    expiresAt: z.number().int().positive(),
    recentUntil: z.number().int().positive().optional(),
  }),
});
export type CustodianRequest = z.infer<typeof request>;
export const CUSTODIAN_REQUEST_LIMIT = 1_048_576;
export function decodeCustodianRequest(value: unknown): CustodianRequest {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > CUSTODIAN_REQUEST_LIMIT)
    throw Error('Custodian request too large');
  const parsed = request.parse(value);
  for (const key of ['actor', 'auth', 'authSession', 'authorization', 'epoch', 'controller'])
    if (Object.hasOwn(parsed.body, key)) throw Error('Caller authority is not accepted');
  custodianRoute(parsed);
  return parsed;
}
export function custodianRoute(input: CustodianSelection) {
  const parsed = selection.parse({
    operation: input.operation,
    sessionId: input.sessionId,
    resourceId: input.resourceId,
    revision: input.revision,
  });
  const [method, template] = operations[parsed.operation];
  const path = template.replace(
    /:(sessionId|resourceId|revision)/g,
    (_, key: 'sessionId' | 'resourceId' | 'revision') => {
      if (!parsed[key]) throw Error('Custodian route identity required');
      return parsed[key];
    },
  );
  for (const key of ['sessionId', 'resourceId', 'revision'] as const)
    if (parsed[key] && !template.includes(`:${key}`)) throw Error('Unexpected custodian identity');
  return { method, path };
}
export function selectCustodianOperation(method: string, path: string): CustodianSelection | null {
  for (const [operation, [verb, template]] of Object.entries(operations)) {
    if (verb !== method) continue;
    const names: string[] = [];
    const pattern = template.replace(/:(sessionId|resourceId|revision)/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}/?$`).exec(path);
    if (!match) continue;
    const result = selection.safeParse({
      operation,
      ...Object.fromEntries(names.map((name, i) => [name, match[i + 1]])),
    });
    return result.success ? result.data : null;
  }
  return null;
}
