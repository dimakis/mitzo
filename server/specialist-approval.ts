import { isDeepStrictEqual } from 'node:util';
import type { UserQuestion } from '@mitzo/protocol';
import { ConsultationAllowanceSchema } from './specialist-consultation-contract.js';

const allowanceQuestion =
  'How many consultations may this policy authorize? Enter a positive number or unlimited.';
const routeQuestion =
  'Approve the exact specialist model, charged account and agent mode for this admission.';
function authorizationQuestion(display: Record<string, unknown>) {
  return `${allowanceQuestion}\n\nRepository: ${display.repository}\nConnection: ${display.connectionId}\nExpires: ${new Date(Number(display.expiresAt)).toISOString()}\nSelected-context limit: ${display.maxContextBytes} bytes\n${routeLabels(display).join('\n')}\nProfiles: ${JSON.stringify((display.routes as Record<string, unknown>[]).map((route) => route.agent))}\n\n${display.scope}`;
}
function routeLabels(display: Record<string, unknown>) {
  return (display.routes as Record<string, unknown>[]).map(
    (route, index) =>
      `${index + 1}. ${route.role}: ${route.model} · ${route.accountLabel ?? route.accountId} (${route.accountId}) · ${route.permissionMode ?? 'ask'} · allowance ${display.maxConsultations ?? 'unlimited'}`,
  );
}
export function specialistApprovalQuestions(display: Record<string, unknown>): UserQuestion[] {
  if (display.kind === 'specialist_admission')
    return [
      {
        id: 'route',
        header: 'Specialist',
        question: routeQuestion,
        multiSelect: false,
        allowFreeform: false,
        options: routeLabels(display).map((label) => ({
          label,
          description: 'Use this approved route for one consultation.',
        })),
      },
    ];
  const requested = String(display.maxConsultations ?? 'unlimited');
  return [
    {
      id: 'allowance',
      header: 'Allowance',
      question: authorizationQuestion(display),
      multiSelect: false,
      options: [...new Set([requested, 'unlimited'])].map((label) => ({
        label,
        description:
          label === 'unlimited'
            ? 'No call-count ceiling; other permissions and expiry still apply.'
            : 'Maximum charged or reserved consultations.',
      })),
    },
  ];
}
/** Only operator answers may change the selected route or allowance. Other
 * approval fields remain byte-for-byte bound to the server's proposal. */
export function specialistApprovalResult(
  display: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  const { answers, ...protectedInput } = updated;
  if (!isDeepStrictEqual(protectedInput, display))
    throw Error('Consultation approval changed protected fields');
  if (!answers) return true; // Existing adapters may return an unchanged reviewed input.
  if (typeof answers !== 'object' || Array.isArray(answers))
    throw Error('Invalid consultation answers');
  const response = answers as Record<string, unknown>;
  if (display.kind === 'specialist_admission') {
    const index = routeLabels(display).indexOf(String(response[routeQuestion]));
    if (index < 0 || Object.keys(response).length !== 1)
      throw Error('Invalid specialist selection');
    return { ...display, routeIndex: index };
  }
  const value = response[authorizationQuestion(display)];
  if (typeof value !== 'string' || Object.keys(response).length !== 1)
    throw Error('Invalid consultation allowance');
  const maxConsultations = ConsultationAllowanceSchema.parse(
    value.trim().toLowerCase() === 'unlimited' ? null : Number(value),
  );
  return { ...display, maxConsultations };
}
