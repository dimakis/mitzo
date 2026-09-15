const GOOGLE_WORKSPACE = 'google-workspace';

// Keep coordinated verbs in one clause so a leading refusal governs each of
// them ("do not search or access Gmail"). Pair matching rejects a
// coordinating connector between a verb and target, so unrelated verbs still
// cannot bind across the coordination.
const REQUEST_CLAUSE_BOUNDARY = /[.!?;\n]+|\b(?:but|while)\b/i;
const EXPLICIT_GOOGLE_SERVICE =
  /\b(?:gmail|gws|google\s+(?:workspace|mail|docs?|drive|sheets?|calendar))\b/gi;
const GENERIC_EMAIL = /\b(?:emails?|mail|inbox)\b/gi;
const GENERIC_CALENDAR = /\bcalendar\b/gi;
const PERSONAL_MAIL = /\b(?:my|our|your)\s+(?:emails?|mail|inbox)\b/gi;
const PERSONAL_CALENDAR = /\b(?:my|our|your)\s+calendar\b/gi;
const PERSONAL_DRIVE = /\b(?:my|our|your)\s+drive\b/gi;
const PERSONAL_DOCS = /\b(?:my|our|your)\s+documents?\b/gi;
const PERSONAL_SHEETS = /\b(?:my|our|your)\s+(?:sheets?|spreadsheets?)\b/gi;

const READ_ACTION =
  /\b(?:access(?:ing|ed)?|check(?:ing|ed)?|find(?:ing)?|fetch(?:ing|ed)?|get(?:ting)?|inspect(?:ing|ed)?|list(?:ing|ed)?|look\s+(?:at|in|through)|open(?:ing|ed)?|quer(?:y|ying|ied)|read(?:ing)?|retriev(?:e|ing|ed)|scan(?:ning|ned)?|search(?:ing|ed)?|show(?:ing|n)?|summari[sz](?:e|ing|ed)|use|using|used|view(?:ing|ed)?)\b/gi;
const WRITE_ACTION =
  /\b(?:archiv(?:e|ing|ed)|cop(?:y|ying|ied)|creat(?:e|ing|ed)|delet(?:e|ing|ed)|download(?:ing|ed)?|draft(?:ing|ed)?|edit(?:ing|ed)?|mov(?:e|ing|ed)|repl(?:y|ying|ied)|schedul(?:e|ing|ed)|send(?:ing|sent)?|shar(?:e|ing|ed)|updat(?:e|ing|ed)|upload(?:ing|ed)?|writ(?:e|ing|ten))\b/gi;
const ENABLE_ACTION =
  /\b(?:add(?:ing|ed)?|attach(?:ing|ed)?|connect(?:ing|ed)?|enabl(?:e|ing|ed)|grant(?:ing|ed)?|permit(?:ting|ted)?|allow(?:ing|ed)?)\b/gi;
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
const CONTENT_SEARCH_TARGET = /\b(?:mentions?|occurrences?|references?|strings?|usages?)\b/i;
const QUOTED_TEXT = /“[^”]*”|‘[^’]*’|"[^"]*"|`[^`]*`|(?<![\p{L}\p{N}])'[^'\n]+'/gu;

function requestClauses(prompt: string): string[] {
  return prompt
    .split(REQUEST_CLAUSE_BOUNDARY)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

type IndexedMatch = {
  text: string;
  index: number;
  end: number;
  firstWord: number;
  lastWord: number;
};
type ClauseMatcher = {
  clause: string;
  actions: IndexedMatch[];
  genericActions: IndexedMatch[];
  apiDataActions: IndexedMatch[];
  explicit: IndexedMatch[];
  personal: Record<'mail' | 'calendar' | 'drive' | 'docs' | 'sheets', IndexedMatch[]>;
  generic: { mail: IndexedMatch[]; calendar: IndexedMatch[] };
  actionsByWord: Map<number, IndexedMatch[]>;
  quoted: Array<{ start: number; end: number }>;
  capabilityStarts: number[];
  thenBoundaries: number[];
};

function createClauseMatcher(clause: string): ClauseMatcher {
  const words: number[] = [];
  for (const word of clause.matchAll(/\S+/g)) words.push(word.index ?? 0);
  const wordAt = (index: number) => {
    let low = 0;
    let high = words.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (words[middle] <= index) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  };
  const indexed = (pattern: RegExp): IndexedMatch[] => {
    pattern.lastIndex = 0;
    return [...clause.matchAll(pattern)].map((match) => {
      const index = match.index ?? 0;
      return {
        text: match[0],
        index,
        end: index + match[0].length,
        firstWord: wordAt(index),
        lastWord: wordAt(index + Math.max(0, match[0].length - 1)),
      };
    });
  };
  const actions = indexed(WORKSPACE_ACTION);
  const genericActions = indexed(GENERIC_WORKSPACE_DATA_ACTION);
  const apiDataActions = indexed(API_DATA_ACTION);
  const actionsByWord = new Map<number, IndexedMatch[]>();
  for (const action of [...actions, ...genericActions, ...apiDataActions])
    for (let word = action.firstWord; word <= action.lastWord; word++) {
      const atWord = actionsByWord.get(word) ?? [];
      atWord.push(action);
      actionsByWord.set(word, atWord);
    }
  QUOTED_TEXT.lastIndex = 0;
  const quoted = [...clause.matchAll(QUOTED_TEXT)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const capabilityStarts = [
    ...clause.matchAll(/\bhow\s+(?:to|do|can|should)\b/gi),
    ...clause.matchAll(/\bwhat\s+can\s+(?:i|we|you)\s+use\b/gi),
  ]
    .map((match) => match.index ?? 0)
    .sort((left, right) => left - right);
  const thenBoundaries = [...clause.matchAll(/\b(?:and\s+)?then\b/gi)].map(
    (match) => (match.index ?? 0) + match[0].length,
  );
  return {
    clause,
    actions,
    genericActions,
    apiDataActions,
    explicit: indexed(EXPLICIT_GOOGLE_SERVICE),
    personal: {
      mail: indexed(PERSONAL_MAIL),
      calendar: indexed(PERSONAL_CALENDAR),
      drive: indexed(PERSONAL_DRIVE),
      docs: indexed(PERSONAL_DOCS),
      sheets: indexed(PERSONAL_SHEETS),
    },
    generic: { mail: indexed(GENERIC_EMAIL), calendar: indexed(GENERIC_CALENDAR) },
    actionsByWord,
    quoted,
    capabilityStarts,
    thenBoundaries,
  };
}

function indexBefore(values: number[], needle: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= needle) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function isQuotedText(matcher: ClauseMatcher, index: number): boolean {
  const quoted = matcher.quoted;
  let low = 0;
  let high = quoted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (quoted[middle].start <= index) low = middle + 1;
    else high = middle;
  }
  const range = quoted[low - 1];
  return Boolean(range && index < range.end);
}

function isCapabilityHowTo(
  matcher: ClauseMatcher,
  action: IndexedMatch,
  target: IndexedMatch,
): boolean {
  // Keep explanation/capability framing bound to its own action phrase. In
  // "explain how to use Gmail and then search Gmail", the second operation is
  // a separate request and must not inherit the explanation's suppression.
  const pairStart = Math.min(action.index, target.index);
  const scopeStart = matcher.thenBoundaries[indexBefore(matcher.thenBoundaries, pairStart)] ?? 0;
  const capability =
    matcher.capabilityStarts[
      indexBefore(matcher.capabilityStarts, Math.max(action.end, target.end))
    ];
  return capability !== undefined && capability >= scopeStart;
}

/**
 * Finds only actions in the six-word neighborhood of each resource match.
 * All regex scans are pre-indexed once per clause; this avoids the former
 * action×resource rescan for repeated service names in large user prompts.
 */
function matchingActionsForResource(
  matcher: ClauseMatcher,
  targets: IndexedMatch[],
  actions: IndexedMatch[],
  isTechnicalArtifact?: (matcher: ClauseMatcher, target: IndexedMatch) => boolean,
): Array<{ index: number; negated: boolean }> {
  const actionSet = new Set(actions);
  const matches: Array<{ index: number; negated: boolean }> = [];
  for (const target of targets) {
    if (isTechnicalArtifact?.(matcher, target) || isQuotedText(matcher, target.index)) continue;
    const nearby = new Set<IndexedMatch>();
    for (let word = Math.max(0, target.firstWord - 7); word <= target.lastWord + 7; word++)
      for (const action of matcher.actionsByWord.get(word) ?? [])
        if (actionSet.has(action)) nearby.add(action);
    for (const action of nearby) {
      if (isQuotedText(matcher, action.index) || isCapabilityHowTo(matcher, action, target))
        continue;
      const betweenWords =
        action.index < target.index
          ? target.firstWord - action.lastWord - 1
          : action.firstWord - target.lastWord - 1;
      if (betweenWords > 6) continue;
      const between =
        action.index < target.index
          ? matcher.clause.slice(action.end, target.index)
          : matcher.clause.slice(target.end, action.index);
      if (/\b(?:about|documentation|docs?|and|or)\b/i.test(between)) continue;
      matches.push({ index: action.index, negated: isNegatedAction(matcher.clause, action.index) });
    }
  }
  return matches;
}

function isNegatedAction(clause: string, actionIndex: number): boolean {
  // Coordination remains in a single clause. Treat a prior explicit refusal
  // as governing later coordinated verbs until a sentence or contrast boundary
  // starts a new clause; ambiguous coordination must not request access.
  const leadStart = Math.max(0, actionIndex - 120);
  const lead = clause.slice(leadStart, actionIndex);
  // A comma followed by an explicit limiter starts a fresh affirmative action
  // phrase ("don't edit code, just search Gmail"). A bare comma remains
  // ambiguous and therefore stays inside the refusal scope.
  let resetEnd = 0;
  for (const reset of lead.matchAll(/(?:^|,)\s*(?:just|instead|rather)\s*/gi))
    resetEnd = (reset.index ?? 0) + reset[0].length;
  const scopedLead = lead.slice(resetEnd);
  const scopedStart = leadStart + resetEnd;
  const negation =
    /\b(?:do\s+not|must\s+not|should\s+not|don't|cannot|can't|never|without|avoid|refrain\s+from)\b/gi;
  for (const match of scopedLead.matchAll(negation)) {
    const afterNegation = clause.slice(
      scopedStart + (match.index ?? 0) + match[0].length,
      actionIndex + 40,
    );
    // Refusals govern a direct Workspace verb phrase (and its coordinated
    // continuations), not an unrelated conversational contraction such as
    // "I don't remember the subject, please search Gmail".
    if (
      new RegExp(
        `^\\s*(?:(?:ever|again|directly|really|please)\\s+)*${WORKSPACE_ACTION.source}`,
        'i',
      ).test(afterNegation)
    )
      return true;
  }
  return false;
}

function isExplicitGoogleServiceArtifact(matcher: ClauseMatcher, target: IndexedMatch): boolean {
  const { clause } = matcher;
  const { index: start, end } = target;
  return (
    new RegExp(`^\\s+${TECHNICAL_ARTIFACT}\\b`, 'i').test(clause.slice(end, end + 120)) ||
    isContentSearchArtifact(matcher, target) ||
    new RegExp(
      `\\b${TECHNICAL_ARTIFACT}\\s+(?:for|about|of|using|with)\\s+(?:the\\s+)?$`,
      'i',
    ).test(clause.slice(Math.max(0, start - 160), start))
  );
}

function isGenericWorkspaceArtifact(matcher: ClauseMatcher, target: IndexedMatch): boolean {
  const { clause } = matcher;
  const { end } = target;
  return (
    new RegExp(`^\\s+${TECHNICAL_ARTIFACT}\\b`, 'i').test(clause.slice(end, end + 120)) ||
    isContentSearchArtifact(matcher, target)
  );
}

function isContentSearchArtifact(matcher: ClauseMatcher, target: IndexedMatch): boolean {
  const { clause } = matcher;
  const { index: start, end } = target;
  return (
    new RegExp(`^\\s+${CONTENT_SEARCH_TARGET.source}`, 'i').test(clause.slice(end, end + 120)) ||
    new RegExp(
      `${CONTENT_SEARCH_TARGET.source}\\s+(?:(?:to|of|about|for)\\s+)?(?:["']\\s*)?$`,
      'i',
    ).test(clause.slice(Math.max(0, start - 160), start))
  );
}

type ResourceState = { resource: string; index: number; affirmative: boolean };

function latestResourceState(
  states: Map<string, ResourceState>,
  resource: string,
  matches: Array<{ index: number; negated: boolean }>,
) {
  const latest = matches.reduce((last, match) => (match.index > last.index ? match : last));
  const current = states.get(resource);
  if (!current || latest.index >= current.index)
    states.set(resource, { resource, index: latest.index, affirmative: !latest.negated });
}

function explicitGoogleServiceStates(matcher: ClauseMatcher): ResourceState[] {
  const states = new Map<string, ResourceState>();
  const targetsByService = new Map<string, IndexedMatch[]>();
  for (const target of matcher.explicit) {
    const service = explicitServiceIdentity(target.text);
    const targets = targetsByService.get(service) ?? [];
    targets.push(target);
    targetsByService.set(service, targets);
  }
  const apiOperation =
    GOOGLE_SERVICE_API_TRANSPORT.test(matcher.clause) ||
    GOOGLE_SERVICE_API_COMMAND.test(matcher.clause);
  for (const [name, targets] of targetsByService) {
    const matches = matchingActionsForResource(
      matcher,
      targets,
      matcher.actions,
      isExplicitGoogleServiceArtifact,
    );
    if (apiOperation)
      matches.push(...matchingActionsForResource(matcher, targets, matcher.apiDataActions));
    if (matches.length) latestResourceState(states, name, matches);
  }
  return [...states.values()];
}

function explicitServiceIdentity(service: string): string {
  const normalized = service.toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'gmail' || normalized === 'google mail') return 'mail';
  if (normalized === 'gws' || normalized === 'google workspace') return 'workspace';
  if (normalized === 'google drive') return 'drive';
  if (normalized === 'google docs' || normalized === 'google doc') return 'docs';
  if (normalized === 'google sheets' || normalized === 'google sheet') return 'sheets';
  if (normalized === 'google calendar') return 'calendar';
  return normalized;
}

function hasClearGenericEmailTarget(clause: string): boolean {
  return (
    /\b(?:emails?|mail)\s+(?:(?:from|by|to|about|that|which)\b|\S+\s+(?:sent|wrote|shared)\b)/i.test(
      clause,
    ) || /\b(?:send|reply)\s+(?:(?:this|an?|the)\s+)?(?:email|mail)\s+(?:to|via)\b/i.test(clause)
  );
}

function hasClearGenericCalendarTarget(clause: string): boolean {
  return (
    /\bcalendar\s+(?:events?|meetings?|schedule|for|on|with|containing)\b/i.test(clause) ||
    /\b(?:create|update|delete|move)\s+(?:an?\s+)?(?:event|meeting|appointment)\s+in\s+(?:my\s+)?calendar\b/i.test(
      clause,
    )
  );
}

function genericPersonalDataStates(matcher: ClauseMatcher): ResourceState[] {
  const { clause } = matcher;
  const states = new Map<string, ResourceState>();
  for (const identity of ['mail', 'calendar', 'drive', 'docs', 'sheets'] as const) {
    const targets = matcher.personal[identity];
    const matches = matchingActionsForResource(
      matcher,
      targets,
      matcher.genericActions,
      isGenericWorkspaceArtifact,
    );
    if (matches.length) latestResourceState(states, identity, matches);
  }
  const calendarQuestion = /\bwhat(?:'s|\s+is)\s+on\s+(?:my|our|your)\s+calendar\b/i.exec(clause);
  if (calendarQuestion)
    states.set('calendar', {
      resource: 'calendar',
      index: calendarQuestion.index,
      affirmative: true,
    });
  const emailQuestion = /\bany\s+(?:new\s+)?(?:emails?|mail)\s+(?:from|by|about|to)\b/i.exec(
    clause,
  );
  if (emailQuestion)
    states.set('mail', { resource: 'mail', index: emailQuestion.index, affirmative: true });
  return [...states.values()];
}

function genericEmailOrCalendarStates(matcher: ClauseMatcher): ResourceState[] {
  const { clause } = matcher;
  const states = new Map<string, ResourceState>();
  for (const [resource, targets, hasClearTarget] of [
    ['mail', matcher.generic.mail, hasClearGenericEmailTarget],
    ['calendar', matcher.generic.calendar, hasClearGenericCalendarTarget],
  ] as const) {
    if (!hasClearTarget(clause)) continue;
    const matches = matchingActionsForResource(
      matcher,
      targets,
      matcher.genericActions,
      isGenericWorkspaceArtifact,
    );
    if (matches.length) latestResourceState(states, resource, matches);
  }
  return [...states.values()];
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

  const activeResources = new Set<string>();
  let workspaceAccessRefused = false;
  for (const clause of requestClauses(prompt)) {
    const matcher = createClauseMatcher(clause);
    const states = [
      ...explicitGoogleServiceStates(matcher),
      ...genericPersonalDataStates(matcher),
      ...genericEmailOrCalendarStates(matcher),
    ].sort((left, right) => left.index - right.index);
    for (const { resource, affirmative } of states) {
      if (resource === 'workspace' && !affirmative) {
        workspaceAccessRefused = true;
        activeResources.clear();
      } else if (affirmative) activeResources.add(resource);
      else activeResources.delete(resource);
    }
  }

  return !workspaceAccessRefused && activeResources.size ? [GOOGLE_WORKSPACE] : [];
}
