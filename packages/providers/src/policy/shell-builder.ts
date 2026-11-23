import { dropAssignments } from "./ps-assignments";
import { type EscapeMode, escapedWord } from "./shell-escapes";

/** Which quoting rules to apply. `auto` is for callers that cannot tell the shell. */
export type ShellDialect = "posix" | "powershell" | "auto";

/** One simple command, such as `git commit -m msg` or `pnpm build > log`. */
export interface SimpleCommand {
  /** Words with quotes and escapes removed. Substitutions such as `$(pwd)` stay as written. */
  words: string[];
  /**
   * Output redirection targets (`> f`, `>> f`, `2> f`, `&> f`, `*> f`), and the items a PowerShell
   * variable on a drive assigns (`${C:\x} = …`, `./ps-variables`).
   */
  writes: string[];
  /**
   * Items a PowerShell variable on a drive reads (`${C:\Users\me\.ssh\id_rsa}` as a value, or
   * inside a double-quoted string or `@"…"@` here-string; `./ps-variables`).
   */
  reads?: string[];
  /** Command lists inside substitutions and subshells (`$(…)`, `(…)`, `<(…)`), in order. */
  nested: SimpleCommand[][];
  /**
   * Command lists inside braces, outside POSIX shells: a PowerShell script block (`if (…) { … }`,
   * `try { … } catch { … }`, `& { … }`, `function f { … }`), and a group or function body of a
   * shell that isn't known (`f() { …; }`). The words keep the block as written, so the rules that
   * read a block as an argument (`-NewName { … }`) still do.
   */
  blocks?: SimpleCommand[][];
  /** True when a block in it never closes, so what it runs can't be read. */
  unparsed?: boolean;
  /** Here-string words (`<<< text`), which the command reads on its input. */
  input?: string[];
  /** True when the command reads the output of the one before it (`a | b`, `a |& b`). */
  piped?: boolean;
  /**
   * PowerShell list arguments (`a,b`: unquoted commas, outside POSIX shells), each word with the
   * positions of its unquoted commas. A comma inside quotes or escaped is part of the name.
   */
  lists?: Map<string, number[]>;
  /**
   * True when the words are the right-hand side of a PowerShell assignment (`$p = '.env'`,
   * `$r = Remove-Item …`), whose target `./ps-assignments` dropped.
   */
  assigned?: boolean;
}

/** What a word may stand for as paths, from `from` on (after an attached option, `-fFILE`). */
export type WordPaths = (word: string, from: number) => string[];

/**
 * The paths a word of `cmd` may stand for, from `from` on: its text and, for a PowerShell list
 * (`a,b`), each element. The whole text stays: when the shell is unknown it may be one name, or a
 * brace expansion (`{a,b}`). Callers apply it after reading the word's role, so a list given as a
 * search pattern stays data.
 */
export function wordPaths(cmd: SimpleCommand, word: string, from = 0): string[] {
  const text = word.slice(from);
  const commas = cmd.lists?.get(word)?.filter((at) => at >= from) ?? [];
  if (!commas.length) return [text];
  const bounds = [from - 1, ...commas, word.length];
  const elements = bounds.slice(1).map((end, k) => word.slice((bounds[k] as number) + 1, end));
  return [text, ...elements.filter(Boolean)];
}

type Target = "word" | "write" | "heredoc" | "skip";

/** The command being built and the word being read. */
export class Builder {
  cmd: SimpleCommand = { words: [], writes: [], nested: [] };
  /** The word as written, backslash escapes kept. */
  word = "";
  inWord = false;
  /** Where the current word goes: an argument, a redirect target or a heredoc delimiter. */
  target: Target = "word";
  heredocStrip = false;
  readonly heredocs: Array<{ delim: string; strip: boolean }> = [];
  /** The word with its backslash escapes taken out (`./shell-escapes`). */
  private plain = "";
  /** True when the word has a backslash escape. */
  private escaped = false;
  /** Where the word's unquoted commas are: a PowerShell list's element boundaries. */
  private commas: number[] = [];
  /** The same commas in `plain`. */
  private plainCommas: number[] = [];

  constructor(
    private readonly out: SimpleCommand[],
    private readonly dialect: ShellDialect,
    private readonly escapes: EscapeMode,
  ) {}

  /** Note an item a PowerShell variable reads. */
  read(item: string): void {
    this.cmd.reads = [...(this.cmd.reads ?? []), item];
  }

  add(text: string): void {
    this.word += text;
    this.plain += text;
    this.inWord = true;
  }

  /** A backslash and the character it escapes. */
  addEscaped(char: string): void {
    this.word += `\\${char}`;
    this.plain += char;
    this.escaped = true;
    this.inWord = true;
  }

  /** An unquoted comma, which separates a PowerShell list's elements (`a,b`). */
  addComma(): void {
    this.commas.push(this.word.length);
    this.plainCommas.push(this.plain.length);
    this.add(",");
  }

  /** Drop the word being read: a file descriptor before a redirect (`2>`). */
  dropWord(): void {
    this.word = "";
    this.plain = "";
    this.escaped = false;
    this.inWord = false;
  }

  endWord(): void {
    if (!this.inWord) return;
    const text = this.escaped ? escapedWord(this.word, this.plain, this.escapes) : this.word;
    const commas = this.escaped && text === this.plain ? this.plainCommas : this.commas;
    if (this.target === "write") this.cmd.writes.push(text);
    else if (this.target === "heredoc") {
      // `<<\EOF` and `<<'EOF'` both end at a line reading `EOF`.
      this.heredocs.push({ delim: this.word.replace(/\\/g, ""), strip: this.heredocStrip });
    } else if (this.target === "word") {
      this.cmd.words.push(text);
      if (commas.length) this.addList(text, commas);
    } else if (this.target === "skip") this.cmd.input = [...(this.cmd.input ?? []), text];
    this.target = "word";
    this.dropWord();
    this.commas = [];
    this.plainCommas = [];
  }

  /**
   * Note where a word's unquoted commas are. The same text written twice with different quoting
   * keeps every comma either one had, so its list is never missed.
   */
  private addList(word: string, found: number[]): void {
    this.cmd.lists ??= new Map();
    const seen = this.cmd.lists.get(word) ?? [];
    const commas = [...new Set([...seen, ...found])].sort((a, b) => a - b);
    this.cmd.lists.set(word, commas);
  }

  endCommand(): void {
    this.endWord();
    this.target = "word";
    const { cmd } = this;
    // PowerShell runs the right-hand side of `$r = Remove-Item …`: judge it as if it stood alone.
    if (this.dialect !== "posix") dropAssignments(cmd);
    // An empty command keeps its state, so `curl … |` then `sh` on the next line stays piped (and
    // `$x =` then a command on the next line assigns that command, as in PowerShell).
    if (!cmd.words.length && !cmd.writes.length && !cmd.nested.length) return;
    this.out.push(cmd);
    this.cmd = { words: [], writes: [], nested: [] };
  }
}
