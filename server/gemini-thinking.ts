/** Reviewed GenerateContent controls: https://cloud.google.com/vertex-ai/generative-ai/docs/thinking */
export function geminiThinkingEfforts(model: string, textTranscript = false): string[] {
  if (/^gemini-2\.5-pro(?:-|$)/.test(model)) return ['low', 'medium', 'high'];
  if (/^gemini-2\.5-flash(?:-|$)/.test(model)) return ['none', 'low', 'medium', 'high'];
  if (/^gemini-3-pro(?:-|$)/.test(model)) return ['low', 'high'];
  if (/^gemini-3\.1-pro(?:-|$)/.test(model)) return ['low', 'medium', 'high'];
  if (/^gemini-3(?:\.[1-8])?-flash(?:-|$)/.test(model))
    // MINIMAL requires provider thought signatures, absent from reviewed text history.
    return textTranscript ? ['low', 'medium', 'high'] : ['minimal', 'low', 'medium', 'high'];
  return [];
}
export function geminiThinkingConfig(model: string, effort?: string, textTranscript = false) {
  if (!effort) return undefined;
  if (!geminiThinkingEfforts(model, textTranscript).includes(effort))
    throw Error('Gemini thinking mode unavailable');
  if (model.startsWith('gemini-2.5-'))
    // Deliberate application presets within every supported 2.5 model's range.
    return { thinkingBudget: { none: 0, low: 512, medium: 1024, high: 2048 }[effort] };
  return { thinkingLevel: effort.toUpperCase() };
}
