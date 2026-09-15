const GOOGLE_WORKSPACE = 'google-workspace';

// Split coordination as well as sentences. A request such as "write the docs
// and search Gmail" should associate `search` with Gmail, but a verb in the
// first half must not authorize an integration named in the second half.
const REQUEST_CLAUSE_BOUNDARY = /[.!?;\n]+|\b(?:and|or|then|but|while)\b/i;
const EXPLICIT_GOOGLE_SERVICE =
  /\b(?:gmail|gws|google\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\b/gi;
const PERSONAL_WORKSPACE_DATA =
  /\b(?:my|our|your)\s+(?:emails?|mail|inbox|calendar|documents?|drive|sheets?|spreadsheets?)\b/gi;
const GENERIC_EMAIL = /\b(?:emails?|mail|inbox)\b/gi;
const GENERIC_CALENDAR = /\bcalendar\b/gi;

const READ_ACTION =
  /\b(?:access|check|find|fetch|get|inspect|list|look\s+(?:at|in|through)|open|query|read|retrieve|scan|search|show|summari[sz]e|use|view)\b/gi;
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
const EXPLICIT_GOOGLE_SERVICE_ARTIFACT = new RegExp(
  `\\b(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\s+${TECHNICAL_ARTIFACT}\\b|\\b${TECHNICAL_ARTIFACT}\\s+(?:for|about|of|using|with)\\s+(?:the\\s+)?(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\b`,
  'i',
);
const GENERIC_WORKSPACE_ARTIFACT = new RegExp(
  `\\b(?:emails?|mail|inbox|calendar)\\s+${TECHNICAL_ARTIFACT}\\b`,
  'i',
);
const API_DATA_ACTION = new RegExp(`${READ_ACTION.source}|${WRITE_ACTION.source}`, 'gi');
const GOOGLE_SERVICE_API_TRANSPORT = new RegExp(
  '\\b(?:via|through|with|using)\\s+(?:the\\s+)?(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\s+api\\b',
  'i',
);
const GOOGLE_SERVICE_API_COMMAND = new RegExp(
  '\\buse\\s+(?:the\\s+)?(?:gmail|gws|google\\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\\s+api\\s+to\\b',
  'i',
);

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
): boolean {
  resource.lastIndex = 0;
  actionPattern.lastIndex = 0;
  for (const action of clause.matchAll(actionPattern)) {
    for (const target of clause.matchAll(resource)) {
      if (target.index === undefined || action.index === undefined) continue;
      const between =
        action.index < target.index
          ? clause.slice(action.index + action[0].length, target.index)
          : clause.slice(target.index + target[0].length, action.index);
      if (wordCount(between) > 6 || /\b(?:about|documentation|docs?)\b/i.test(between)) continue;
      return true;
    }
  }
  return false;
}

function hasExplicitGoogleWorkspaceIntent(clause: string): boolean {
  return (
    hasActionForResource(clause, EXPLICIT_GOOGLE_SERVICE) &&
    (!EXPLICIT_GOOGLE_SERVICE_ARTIFACT.test(clause) || hasActiveGoogleServiceApiOperation(clause))
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
    !GENERIC_WORKSPACE_ARTIFACT.test(clause) &&
    hasClearGenericEmailOrCalendarTarget(clause) &&
    (hasActionForResource(clause, PERSONAL_WORKSPACE_DATA, GENERIC_WORKSPACE_DATA_ACTION) ||
      hasActionForResource(clause, GENERIC_EMAIL, GENERIC_WORKSPACE_DATA_ACTION) ||
      hasActionForResource(clause, GENERIC_CALENDAR, GENERIC_WORKSPACE_DATA_ACTION))
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
