import { expect, it } from 'vitest';
import { specialistApprovalQuestions, specialistApprovalResult } from '../specialist-approval.js';

const display = {
  repository: 'example/project',
  connectionId: 'repository-connection',
  expiresAt: 1800000000000,
  maxContextBytes: 20000,
  maxConsultations: 4,
  scope: 'Selected public context only; no inherited authority.',
  routes: [
    {
      role: 'planner',
      model: 'chosen-model',
      accountId: 'charged-account',
      permissionMode: 'agent',
      agent: { profileId: 'planner', version: 1 },
    },
  ],
};
it('shows the complete authorization alongside an editable allowance', () => {
  const question = specialistApprovalQuestions(display)[0].question;
  for (const value of [
    'example/project',
    'repository-connection',
    '20000',
    'planner',
    'chosen-model',
    'charged-account',
    'agent',
    display.scope,
  ])
    expect(question).toContain(value);
  expect(
    specialistApprovalResult(display, { ...display, answers: { [question]: 'unlimited' } }),
  ).toEqual({ ...display, maxConsultations: null });
  expect(specialistApprovalResult(display, { ...display, answers: { [question]: '25' } })).toEqual({
    ...display,
    maxConsultations: 25,
  });
  expect(() =>
    specialistApprovalResult(display, {
      ...display,
      repository: 'other/project',
      answers: { [question]: '25' },
    }),
  ).toThrow('protected fields');
  expect(() =>
    specialistApprovalResult(display, { ...display, answers: { [question]: '0' } }),
  ).toThrow();
});
it('only accepts an explicitly displayed alternative and preserves its requested mode', () => {
  const admission = {
    ...display,
    kind: 'specialist_admission',
    routes: [
      ...display.routes,
      { ...display.routes[0], model: 'alternative', permissionMode: 'auto' },
    ],
  };
  const question = specialistApprovalQuestions(admission)[0];
  expect(
    specialistApprovalResult(admission, {
      ...admission,
      answers: { [question.question]: question.options![1].label },
    }),
  ).toEqual({ ...admission, routeIndex: 1 });
  expect(() =>
    specialistApprovalResult(admission, {
      ...admission,
      answers: { [question.question]: 'unlisted model' },
    }),
  ).toThrow('Invalid specialist selection');
});
