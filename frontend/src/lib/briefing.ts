import type { BriefingSnapshot, SourceSnapshot } from '@mitzo/protocol';

export interface BriefingSection {
  title: string;
  level: number;
  kind: 'calendar' | 'jira' | 'meeting' | 'source';
  /** Original heading and body, including whitespace, excluding nested sections. */
  raw: string;
  body: string;
  children: BriefingSection[];
}

/** Lossless outline: unfamiliar content stays visible, fenced headings stay in their source. */
export function parseBriefing(content: string): BriefingSection {
  const root: BriefingSection = {
    title: '',
    level: 0,
    kind: 'source',
    raw: '',
    body: '',
    children: [],
  };
  const stack = [root];
  let fence: { marker: string; length: number } | null = null;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const fenced = line.match(/^ {0,3}(`{3,}|~{3,})/);
    const heading = !fence && line.match(/^ {0,3}(#{2,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop();
      const title = heading[2];
      const kind = /\b\d{1,2}:\d{2}\b/.test(title)
        ? 'meeting'
        : /jira|sprint items/i.test(title)
          ? 'jira'
          : /notices|calendar|holiday|manager|site|workspace health|agent ops/i.test(title)
            ? 'calendar'
            : 'source';
      const section: BriefingSection = { title, level, kind, raw: line, body: '', children: [] };
      stack.at(-1)!.children.push(section);
      stack.push(section);
    } else {
      stack.at(-1)!.raw += line;
      stack.at(-1)!.body += line;
    }
    if (fenced) {
      if (!fence) fence = { marker: fenced[1][0], length: fenced[1].length };
      else if (
        fenced[1][0] === fence.marker &&
        fenced[1].length >= fence.length &&
        /^ {0,3}(`+|~+)\s*$/.test(line)
      )
        fence = null;
    }
  }
  return root;
}

export function briefingSource(snapshot: BriefingSnapshot): SourceSnapshot {
  return {
    kind: 'briefing',
    date: snapshot.date,
    revision: snapshot.revision,
    content: snapshot.content,
  };
}
