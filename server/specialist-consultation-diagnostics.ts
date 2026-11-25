/** Only reviewed, fixed diagnostics cross the tool boundary. Original causes
 * remain in the controller's structured log, never in a tool error string. */
export function specialistDiagnostic(cause: unknown) {
  const message = cause instanceof Error ? cause.message : '';
  const rules = [
    [
      /^Selected model is Off/,
      'model_off',
      'This model is Off in Symposium model policy. Edit Model policy in Agents or explicitly select an eligible model. No replacement was selected.',
    ],
    [
      /^Model consultation allowance/,
      'model_allowance_exhausted',
      'This model has reached its conversation allowance. Edit or remove its allowance in Agents → Model policy.',
    ],
    [
      /^Model policy changed/,
      'model_policy_changed',
      'Model policy changed before admission. Inspect the current policy and recover the original request for fresh review.',
    ],
    [
      /^Specialist admission was not approved/,
      'admission_not_approved',
      'The specialist admission was not approved. No consultation was reserved or dispatched.',
    ],
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
      'The approved consultation allowance is exhausted. Edit or remove it in Agents → Model policy before more model work.',
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
      /^Repository source is not configured for this specialist account(?: \([a-z_]+\))?$/,
      'repository_source_unassigned',
      'The selected repository and connection are not assigned to this specialist account. Pick a repository listed for that accountId in catalog, or ask the operator to assign the connection to the account in Connections.',
    ],
    [
      /^Specialist runtime is unavailable$/,
      'specialist_runtime_unavailable',
      'The specialist account has no compatible runtime for this route now. Inspect catalog and choose an available account and route.',
    ],
    [
      /^Specialist consultation policy was not approved$/,
      'policy_not_approved',
      'The operator did not approve this consultation policy. Nothing was authorized; review a new requestId only if the operator asks.',
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
