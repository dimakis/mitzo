const GOOGLE_WORKSPACE = 'google-workspace';

// Keep coordinated verbs in one clause so a leading refusal governs each of
// them ("do not search or access Gmail"). `hasActionForResource` rejects a
// coordinating connector between a verb and target, so unrelated verbs still
// cannot bind across the coordination.
const REQUEST_CLAUSE_BOUNDARY = /[.!?;\n]+|\b(?:but|while)\b/i;
const EXPLICIT_GOOGLE_SERVICE =
  /\b(?:gmail|gws|google\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\b/gi;
const PERSONAL_WORKSPACE_DATA =
  /\b(?:my|our|your)\s+(?:emails?|mail|inbox|calendar|documents?|drive|sheets?|spreadsheets?)\b/gi;
const GENERIC_EMAIL = /\b(?:emails?|mail|inbox)\b/gi;
const GENERIC_CALENDAR = /\bcalendar\b/gi;

const READ_ACTION =
  /\b(?:access(?:ing|ed)?|check(?:ing|ed)?|find(?:ing)?|fetch(?:ing|ed)?|get(?:ting)?|inspect(?:ing|ed)?|list(?:ing|ed)?|look\s+(?:at|in|through)|open(?:ing|ed)?|quer(?:y|ying|ied)|read(?:ing)?|retriev(?:e|ing|ed)|scan(?:ning|ned)?|search(?:ing|ed)?|show(?:ing|n)?|summari[sz](?:e|ing|ed)|use|using|used|view(?:ing|ed)?)\b/gi;
const WRITE_ACTION =
  /\b(?:archive|copy|create|delete|download|draft|edit|move|reply|schedule|send|share|update|upload|write)\b/gi;
const ENABLE_ACTION = /\b(?:add|attach|connect|enable|grant|permit|allow)\b/gi;
const WORKSPACE_ACTION = new RegExp(
  `${READ_ACTION.source}|${WRITE_ACTION.source}|${ENABLE_ACTION.source}`,
  'gi',
);
const GENERIC_WORKSPACE_DATA_ACTION = new RegExp(
  `${READ_ACTION.source}|\\b(?:create|delete|move|reply|schedule|send|update)\\b`,
  'gi',
);

// Treat a resource as a technical/content artifact only when the technical
// noun describes that resource (for example, "Gmail handler" or "calendar
// UI"). A technical email subject such as "the API migration email in Gmail"
// must still request account access.
const TECHNICAL_ARTIFACT =
  '(?:api|backend|code|codebase|component|css|database|docs?|documentation|endpoint|frontend|handler|html|implementation|module|parser|repository|repo|schema|source|test(?:s|ing)?|ui)';
const API_DATA_ACTION = new RegExp(`${READ_ACTION.source}|${WRITE_ACTION.source}`, 'gi');
const GOOGLE_SERVICE_API_TRANSPORT = new RegExp(
  '\\b(?:via|through|with|using)\\s+(?:the\\s+)?(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\s+api\\b',
  'i',
);
const GOOGLE_SERVICE_API_COMMAND = new RegExp(
  '\\buse\\s+(?:the\\s+)?(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\s+api\\s+to\\b',
  'i',
);
const CAPABILITY_HOW_TO = /\bhow\s+(?:to|do|can|should)\b/i;
const CAPABILITY_WHAT_CAN_USE = /\bwhat\s+can\s+(?:i|we|you)\s+use\b/i;
const CONTENT_SEARCH_TARGET = /\b(?:mentions?|occurrences?|references?|strings?|usages?)\b/i;

function requestClauses(prompt: string): string[] {
  return prompt
    .split(REQUEST_CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Returns true only when an operation and its target occur near one another
 * in the same small request clause. This deliberately avoids binding a verb
 * in a different sentence (or a different side of "and") to a Google service
 * mention, while allowing natural resource-first requests such as
 * "In Gmail, find the message".
 */
function hasActionForResource(
  clause: string,
  resource: RegExp,
  actionPattern = WORKSPACE_ACTION,
  isTechnicalArtifact?: (clause: string, target: RegExpMatchArray) => boolean,
): boolean {
  resource.lastIndex = 0;
  actionPattern.lastIndex = 0;
  for (const action of clause.matchAll(actionPattern)) {
    for (const target of clause.matchAll(resource)) {
      if (target.index === undefined || action.index === undefined) continue;
      if (isTechnicalArtifact?.(clause, target)) continue;
      if (isNegatedAction(clause, action.index)) continue;
      if (isCapabilityHowTo(clause, action, target)) continue;
      const between =
        action.index < target.index
          ? clause.slice(action.index + action[0].length, target.index)
          : clause.slice(target.index + target[0].length, action.index);
      if (wordCount(between) > 6 || /\b(?:about|documentation|docs?|and|or)\b/i.test(between))
        continue;
      return true;
    }
  }
  return false;
}

function isCapabilityHowTo(
  clause: string,
  action: RegExpMatchArray,
  target: RegExpMatchArray,
): boolean {
  // Keep explanation/capability framing bound to its own action phrase. In
  // "explain how to use Gmail and then search Gmail", the second operation is
  // a separate request and must not inherit the explanation's suppression.
  const pairStart = Math.min(action.index!, target.index!);
  let scopeStart = 0;
  for (const boundary of clause.slice(0, pairStart).matchAll(/\b(?:and\s+)?then\b/gi))
    scopeStart = (boundary.index ?? 0) + boundary[0].length;
  const scope = clause.slice(
    scopeStart,
    Math.max(action.index! + action[0].length, target.index! + target[0].length),
  );
  return CAPABILITY_HOW_TO.test(scope) || CAPABILITY_WHAT_CAN_USE.test(scope);
}

function isNegatedAction(clause: string, actionIndex: number): boolean {
  // Coordination remains in a single clause. Treat a prior explicit refusal
  // as governing later coordinated verbs until a sentence or contrast boundary
  // starts a new clause; ambiguous coordination must not request access.
  const lead = clause.slice(Math.max(0, actionIndex - 120), actionIndex);
  // A comma followed by an explicit limiter starts a fresh affirmative action
  // phrase ("don't edit code, just search Gmail"). A bare comma remains
  // ambiguous and therefore stays inside the refusal scope.
  let resetEnd = 0;
  for (const reset of lead.matchAll(/(?:^|,)\s*(?:just|instead|rather)\s*/gi))
    resetEnd = (reset.index ?? 0) + reset[0].length;
  const scopedLead = lead.slice(resetEnd);
  return (
    /\b(?:do\s+not|must\s+not|should\s+not|don't|cannot|can't|never|without|avoid)\b/i.test(
      scopedLead,
    ) || /\brefrain\s+from\b/i.test(scopedLead)
  );
}

function isExplicitGoogleServiceArtifact(clause: string, target: RegExpMatchArray): boolean {
  const start = target.index!;
  const end = start + target[0].length;
  return (
    new RegExp(`^\\s+${TECHNICAL_ARTIFACT}\\b`, 'i').test(clause.slice(end)) ||
    isContentSearchArtifact(clause, target) ||
    new RegExp(
      `\\b${TECHNICAL_ARTIFACT}\\s+(?:for|about|of|using|with)\\s+(?:the\\s+)?$`,
      'i',
    ).test(clause.slice(0, start))
  );
}

function isGenericWorkspaceArtifact(clause: string, target: RegExpMatchArray): boolean {
  const end = target.index! + target[0].length;
  return (
    new RegExp(`^\\s+${TECHNICAL_ARTIFACT}\\b`, 'i').test(clause.slice(end)) ||
    isContentSearchArtifact(clause, target)
  );
}

function isContentSearchArtifact(clause: string, target: RegExpMatchArray): boolean {
  const start = target.index!;
  const end = start + target[0].length;
  return (
    new RegExp(`^\\s+${CONTENT_SEARCH_TARGET.source}`, 'i').test(clause.slice(end)) ||
    new RegExp(
      `${CONTENT_SEARCH_TARGET.source}\\s+(?:(?:to|of|about|for)\\s+)?(?:["']\\s*)?$`,
      'i',
    ).test(clause.slice(0, start))
  );
}

function hasExplicitGoogleWorkspaceIntent(clause: string): boolean {
  return (
    hasActionForResource(
      clause,
      EXPLICIT_GOOGLE_SERVICE,
      WORKSPACE_ACTION,
      isExplicitGoogleServiceArtifact,
    ) || hasActiveGoogleServiceApiOperation(clause)
  );
}

function hasActiveGoogleServiceApiOperation(clause: string): boolean {
  return (
    hasActionForResource(clause, EXPLICIT_GOOGLE_SERVICE, API_DATA_ACTION) &&
    (GOOGLE_SERVICE_API_TRANSPORT.test(clause) || GOOGLE_SERVICE_API_COMMAND.test(clause))
  );
}

function hasClearGenericEmailOrCalendarTarget(clause: string): boolean {
  const namesPersonalData = new RegExp(PERSONAL_WORKSPACE_DATA.source, 'i').test(clause);
  const emailHasMessageTarget =
    /\b(?:emails?|mail)\s+(?:(?:from|by|to|about|that|which)\b|\S+\s+(?:sent|wrote|shared)\b)/i.test(
      clause,
    ) || /\b(?:send|reply)\s+(?:(?:this|an?|the)\s+)?(?:email|mail)\s+(?:to|via)\b/i.test(clause);
  const calendarHasEventTarget =
    /\bcalendar\s+(?:events?|meetings?|schedule|for|on|with|containing)\b/i.test(clause) ||
    /\b(?:create|update|delete|move)\s+(?:an?\s+)?(?:event|meeting|appointment)\s+in\s+(?:my\s+)?calendar\b/i.test(
      clause,
    );

  return namesPersonalData || emailHasMessageTarget || calendarHasEventTarget;
}

function hasGenericWorkspaceIntent(clause: string): boolean {
  return (
    hasClearGenericEmailOrCalendarTarget(clause) &&
    (hasActionForResource(
      clause,
      PERSONAL_WORKSPACE_DATA,
      GENERIC_WORKSPACE_DATA_ACTION,
      isGenericWorkspaceArtifact,
    ) ||
      hasActionForResource(
        clause,
        GENERIC_EMAIL,
        GENERIC_WORKSPACE_DATA_ACTION,
        isGenericWorkspaceArtifact,
      ) ||
      hasActionForResource(
        clause,
        GENERIC_CALENDAR,
        GENERIC_WORKSPACE_DATA_ACTION,
        isGenericWorkspaceArtifact,
      ))
  );
}

/**
 * Maps a user's ordinary request to integrations that must be attached before
 * model execution. Keep this conservative: asking to draft an email or discuss
 * a calendar should not expose external account data.
 */
export function requestedIntegrationProviders(
  prompt: string,
  grantableProviders: readonly string[],
): string[] {
  if (!grantableProviders.includes(GOOGLE_WORKSPACE)) return [];

  const asksForWorkspaceData = requestClauses(prompt).some(
    (clause) => hasExplicitGoogleWorkspaceIntent(clause) || hasGenericWorkspaceIntent(clause),
  );

  return asksForWorkspaceData ? [GOOGLE_WORKSPACE] : [];
}
