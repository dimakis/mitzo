/** Only reviewed, fixed diagnostics cross the tool boundary. Original causes
 * remain in the controller's structured log, never in a tool error string. */
export function specialistDiagnostic(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  const rules = [
    [
      /^No eligible independent specialist/,
      'independent_route_unavailable',
      'No independent specialist route is authorized and available for this role. Inspect catalog and review the policy; no replacement model was selected.',
    ],
    [
      /^Role .* needs one exact published specialist/,
      'profile_selection_required',
      'This role needs one exact published specialist. Select its saved revision from catalog in the policy.',
    ],
    [
      /^Review Agents sharing|Choose one shared conversation/,
      'audience_changed',
      'Review sharing in Agents. Consultation context cannot be broadcast to other readers or an ambiguous conversation.',
    ],
    [
      /context recipe|context packs/i,
      'context_recipe_unsupported',
      'This profile context recipe is not qualified on the selected runtime. Choose a supported profile and route.',
    ],
    [
      /^OpenShell specialist|^Gemini shared/,
      'runtime_unsupported',
      'This specialist runtime is not qualified for shared delivery. Choose an eligible configured local route.',
    ],
    [
      /^Selected context exceeds/,
      'context_limit',
      'Selected context exceeds the approved byte limit. Narrow the selection explicitly.',
    ],
    [
      /^Consultation call budget/,
      'budget_exhausted',
      'The approved consultation call budget is exhausted. Request a new bounded policy before more model work.',
    ],
    [
      /^Consultation policy expired or revoked|^Original consultation authorization/,
      'policy_unavailable',
      'The original consultation policy expired, was revoked or belongs to another login. Known activity remains readable.',
    ],
    [
      /^Consultation.*conflict|^Specialist .*changed/,
      'selection_changed',
      'The original request, profile, account or owner changed. Inspect the retained receipt and review a new policy where needed.',
    ],
    [
      /^Another consultation is preparing/,
      'consultation_busy',
      'Another consultation is preparing. Retain this requestId and retry after it settles.',
    ],
    [
      /^Independent review requires/,
      'contribution_not_completed',
      'Independent review requires a completed attributed contribution. Read the original request first.',
    ],
    [
      /^Shared specialist participants cannot recruit/,
      'recursive_consultation_denied',
      'Bounded specialists cannot recruit other specialists. Return the request to the accountable lead.',
    ],
    [
      /^Ask mode cannot/,
      'ask_mode',
      'Ask mode cannot authorize, request or recover specialist model work.',
    ],
  ] as const;
  for (const [pattern, code, text] of rules)
    if (pattern.test(message)) return { code, message: text };
  return {
    code: 'specialist_tool_failed',
    message:
      'Specialist operation failed. Inspect the original request and policy before retrying.',
  };
}
