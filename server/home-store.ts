import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BriefingChatBinding,
  DailyQuote,
  HomePreferences,
  PhilosophyQuote,
} from '@mitzo/protocol';

const MAX_STATE_BYTES = 4 * 1024 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const url = z.string().url().startsWith('https://').max(2000);
export const quoteSchema = z
  .object({
    id: text(100),
    text: text(2000),
    author: text(200),
    work: text(300),
    translation: text(200),
    explanation: text(5000),
    example: text(2000),
    biography: text(2000),
    sourceUrl: url,
    explainerUrl: url,
    authorUrl: url,
  })
  .strict();
const namesSchema = z
  .object({ briefing: z.string().trim().max(80), terminal: z.string().trim().max(80) })
  .strict();
const pinSchema = z
  .object({
    kind: z.enum(['session', 'telos']),
    id: z.string().regex(/^[\w.:-]{1,200}$/),
    title: text(500),
  })
  .strict();
const pinsSchema = z
  .array(pinSchema)
  .max(100)
  .refine(
    (pins) => new Set(pins.map((pin) => `${pin.kind}:${pin.id}`)).size === pins.length,
    'Duplicate pins',
  );
export const homeUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    names: namesSchema.partial().optional(),
    pins: pinsSchema.optional(),
  })
  .strict();
export const briefingChatSchema = z
  .object({
    date: z.string().refine(validDate, 'Invalid date'),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    sessionId: z.string().regex(/^[\w.:-]{1,200}$/),
    accountId: text(200),
    model: text(200),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    names: namesSchema,
    pins: pinsSchema,
    quotes: z.array(z.object({ date: z.string(), quote: quoteSchema }).strict()).max(60),
    remaining: z.array(z.string()).max(10000),
    briefingChats: z
      .array(briefingChatSchema.extend({ createdAt: z.string().datetime() }))
      .max(1000)
      .default([]),
  })
  .strict();
type State = z.infer<typeof stateSchema>;

export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date);
}
export class HomeConflict extends Error {
  readonly status = 409;
  constructor() {
    super('Preferences changed on another device. Reload and try again.');
  }
}

/** Synchronous read/compare/write serializes requests in the app's single owning process. */
export class HomeStore {
  constructor(private readonly path: string) {}
  private read(): State {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          version: 1,
          revision: 0,
          names: { briefing: 'Minion', terminal: 'Minion' },
          pins: [],
          quotes: [],
          remaining: [],
          briefingChats: [],
        };
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES)
        throw new Error('Invalid home preferences file');
      return stateSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    } finally {
      closeSync(fd);
    }
  }
  private write(state: State) {
    const bytes = Buffer.from(JSON.stringify(state), 'utf8');
    if (bytes.length > MAX_STATE_BYTES) throw new Error('Home preferences are too large');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the original write result; an unpublished temporary file is harmless.
      }
    }
  }
  preferences(): HomePreferences {
    const { revision, names, pins } = this.read();
    return { revision, names, pins };
  }
  briefingChats(date: string, revision: string): BriefingChatBinding[] {
    if (!validDate(date) || !/^[a-f0-9]{64}$/.test(revision))
      throw new Error('Invalid report identity');
    return this.read().briefingChats.filter(
      (chat) => chat.date === date && chat.revision === revision,
    );
  }
  briefingChatForSession(sessionId: string): BriefingChatBinding[] {
    if (!/^[\w.:-]{1,200}$/.test(sessionId)) throw new Error('Invalid session identity');
    return this.read().briefingChats.filter((chat) => chat.sessionId === sessionId);
  }
  registerBriefingChat(input: Omit<BriefingChatBinding, 'createdAt'>): BriefingChatBinding {
    const binding = briefingChatSchema.parse(input);
    const state = this.read();
    const previous = state.briefingChats.find((chat) => chat.sessionId === binding.sessionId);
    if (previous) {
      if (
        previous.date !== binding.date ||
        previous.revision !== binding.revision ||
        previous.accountId !== binding.accountId ||
        previous.model !== binding.model
      )
        throw new Error('Session already belongs to another briefing or selection');
      return previous;
    }
    if (state.briefingChats.length >= 1000) throw new Error('Briefing chat history is full');
    const entry = { ...binding, createdAt: new Date().toISOString() };
    state.briefingChats.push(entry);
    this.write(state);
    return entry;
  }
  update(
    revision: number,
    changes: { names?: Partial<HomePreferences['names']>; pins?: HomePreferences['pins'] },
  ): HomePreferences {
    const patch = homeUpdateSchema.parse({ revision, ...changes });
    const state = this.read();
    if (state.revision !== patch.revision) throw new HomeConflict();
    if (patch.names)
      state.names = {
        briefing:
          patch.names.briefing === undefined
            ? state.names.briefing
            : patch.names.briefing || 'Minion',
        terminal:
          patch.names.terminal === undefined
            ? state.names.terminal
            : patch.names.terminal || 'Minion',
      };
    if (patch.pins) state.pins = patch.pins;
    state.revision++;
    this.write(state);
    return this.preferences();
  }
  dailyQuote(date: string, catalog: PhilosophyQuote[]): DailyQuote {
    if (!validDate(date)) throw new Error('Invalid date');
    const state = this.read();
    const saved = state.quotes.find((quote) => quote.date === date);
    if (saved) return saved;
    const approved = z.array(quoteSchema).min(1).max(10000).parse(catalog);
    if (new Set(approved.map((quote) => quote.id)).size !== approved.length)
      throw new Error('Duplicate quote IDs');
    const ids = new Set(approved.map((quote) => quote.id));
    state.remaining = state.remaining.filter((id) => ids.has(id));
    if (!state.remaining.length) {
      state.remaining = [...ids];
      for (let i = state.remaining.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [state.remaining[i], state.remaining[j]] = [state.remaining[j], state.remaining[i]];
      }
      if (state.remaining.length > 1 && state.remaining.at(-1) === state.quotes.at(-1)?.quote.id)
        [state.remaining[0], state.remaining[state.remaining.length - 1]] = [
          state.remaining[state.remaining.length - 1],
          state.remaining[0],
        ];
    }
    const id = state.remaining.pop();
    const entry = { date, quote: approved.find((quote) => quote.id === id)! };
    state.quotes = [...state.quotes, entry].slice(-60);
    this.write(state);
    return entry;
  }
}
