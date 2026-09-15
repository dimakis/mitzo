const GOOGLE_WORKSPACE = 'google-workspace';

const GOOGLE_RESOURCE =
  /\b(?:gmail|gws|google\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\b/i;
const PERSONAL_WORKSPACE_RESOURCE =
  /\b(?:my|our)\s+(?:emails?|mail|inbox|calendar|docs?|documents?|drive|sheets?|spreadsheets?)\b/i;
const MAIL_RESOURCE = /\b(?:emails?|mail|inbox)\b/i;
const CALENDAR_RESOURCE = /\bcalendar\b/i;
const READ_ACTION =
  /\b(?:access|check|find|fetch|get|inspect|list|look\s+(?:at|in|through)|open|query|read|retrieve|scan|search|show|summari[sz]e|use|view)\b/i;
const ENABLE_ACTION = /\b(?:add|attach|connect|enable|grant|permit|allow)\b/i;

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

  const explicitlyNamesGoogle = GOOGLE_RESOURCE.test(prompt);
  const namesPersonalWorkspaceData = PERSONAL_WORKSPACE_RESOURCE.test(prompt);
  const asksToReadWorkspaceData =
    READ_ACTION.test(prompt) &&
    (explicitlyNamesGoogle ||
      namesPersonalWorkspaceData ||
      MAIL_RESOURCE.test(prompt) ||
      CALENDAR_RESOURCE.test(prompt));
  const asksToEnableGoogle = ENABLE_ACTION.test(prompt) && explicitlyNamesGoogle;

  return asksToReadWorkspaceData || asksToEnableGoogle ? [GOOGLE_WORKSPACE] : [];
}
