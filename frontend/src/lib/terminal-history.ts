/** Deliberately submitted commands only; raw TTY input (including passwords) is never captured. */
export class CommandHistory {
  entries: string[];
  private cursor: number;
  private draft = '';
  constructor(entries: string[] = []) {
    this.entries = entries.slice(-100);
    this.cursor = this.entries.length;
  }
  add(command: string) {
    if (command.trim() && this.entries.at(-1) !== command)
      this.entries = [...this.entries, command].slice(-100);
    this.cursor = this.entries.length;
    this.draft = '';
  }
  previous(draft: string) {
    if (this.cursor === this.entries.length) this.draft = draft;
    this.cursor = Math.max(0, this.cursor - 1);
    return this.entries[this.cursor] ?? draft;
  }
  next() {
    this.cursor = Math.min(this.entries.length, this.cursor + 1);
    return this.cursor === this.entries.length ? this.draft : this.entries[this.cursor];
  }
}
