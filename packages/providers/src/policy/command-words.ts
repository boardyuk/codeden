/** Helpers for reading the words of a parsed simple command (§11.2). */

/** Shell keywords that start a compound command (`if`, `then`, `do`, `{`, ...). */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "time", "!", "{"]);

/** A shell variable assignment (`NAME=value`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * cmd's `@` before a program, which only stops the command being echoed: `@set AWS`,
 * `do @echo %i`. Not PowerShell's `@(…)` and `@{…}`.
 */
const ECHO_OFF = /^@[\w%.\\/]/;

/** A command's words without the ones that don't change what runs (`unwrap`). */
export interface Unwrapped {
  /** The program and its arguments. */
  tokens: string[];
  elevated: boolean;
  /** The folders `env -C dir` (`--chdir`) moves into before running it, in order. */
  chdir: string[];
  /** The variable assignments before it (`GIT_DIR=x git …`, `env GIT_DIR=x git …`). */
  assigns: string[];
}

/**
 * Words that don't change what runs: elevation (`sudo`), wrappers (`env -u X Y=1`, `command`,
 * `builtin`, `exec`), shell keywords that start a compound command (`if`, `then`, `do`, `{`, ...) and cmd's
 * `@`. `env` with no command to run prints the environment, so it stays the program then.
 */
export function unwrap(words: string[]): Unwrapped {
  let elevated = false;
  let rest = words;
  const chdir: string[] = [];
  const assigns: string[] = [];
  for (;;) {
    const head = rest[0]?.toLowerCase();
    if (head === "sudo" || head === "doas" || head === "runas" || head === "gsudo") {
      elevated = true;
      rest = rest.slice(1).filter((t, i) => !(i === 0 && t.startsWith("-")));
    } else if (binName(head) === "env") {
      // Also `/usr/bin/env node x.js` and `env.exe …`.
      const command = envCommand(rest.slice(1), chdir);
      if (command.every((w) => ASSIGNMENT.test(w))) break;
      rest = command;
    } else if (head === "command" || head === "builtin" || head === "exec" || head === "nohup") {
      rest = rest.slice(1);
    } else if (head && KEYWORDS.has(head)) {
      rest = rest.slice(1);
    } else if (head && ASSIGNMENT.test(head)) {
      assigns.push(rest[0] as string);
      rest = rest.slice(1);
    } else if (head === "@") {
      rest = rest.slice(1);
    } else if (head && ECHO_OFF.test(head)) {
      rest = [(rest[0] as string).slice(1), ...rest.slice(1)];
    } else break;
  }
  return { tokens: rest, elevated, chdir, assigns };
}

/** `env`'s short options that take a value: `-u NAME`, `-C DIR`, `-S STRING`, `-P PATH`, `-a ARG`. */
const ENV_VALUE = "uCSPa";
/** `env`'s long options that take a value. */
const ENV_LONG_VALUE = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);

/**
 * The words after `env`'s options: its assignments and the command it runs. The folders it moves
 * into (`-C dir`, `--chdir=dir`) are added to `chdir`. `-S "…"` (`--split-string`) gives more
 * words as one string, options included, read here like the others.
 */
function envCommand(args: string[], chdir: string[]): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-")) return args.slice(i);
    let value: string | undefined;
    let option: string;
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.split("=");
      if (!ENV_LONG_VALUE.has(name)) continue;
      value = rest.length > 0 ? rest.join("=") : args[++i];
      option = name === "--split-string" ? "S" : name === "--chdir" ? "C" : "";
    } else {
      const at = [...arg.slice(1)].findIndex((c) => ENV_VALUE.includes(c)) + 1;
      if (at === 0) continue;
      value = arg.slice(at + 1) || args[++i];
      option = arg[at] as string;
    }
    if (option === "C" && value !== undefined) chdir.push(value);
    if (option === "S") {
      return envCommand(
        [...(value ?? "").split(/\s+/).filter(Boolean), ...args.slice(i + 1)],
        chdir,
      );
    }
  }
  return [];
}

/** Commands that change the shell's current directory. */
export const CD = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);

/**
 * The value of a PowerShell-style named parameter, if present: `-Path x`, or bound with a
 * colon, `-Path:x`.
 */
export function namedArg(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] as string).toLowerCase();
    if (names.includes(arg)) return args[i + 1];
    const bound = names.find((name) => arg.startsWith(`${name}:`));
    if (bound) return (args[i] as string).slice(bound.length + 1);
  }
  return undefined;
}

/**
 * A cmdlet's arguments with each PowerShell script block (`-NewName { $_.Name + '.bak' }`) joined
 * into one, as PowerShell passes it (#541). A block runs from a word starting with `{` to the word
 * that closes it, braces counted, or to the end of the words when a `;` inside it ended the command
 * early. Quotes are gone by then, so a brace inside a string in the block counts too.
 */
export function joinScriptBlocks(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!isScriptBlock(arg)) {
      out.push(arg);
      continue;
    }
    const block = [arg];
    let depth = braces(arg);
    while (depth > 0 && i + 1 < args.length) {
      i += 1;
      block.push(args[i] as string);
      depth += braces(args[i] as string);
    }
    out.push(block.join(" "));
  }
  return out;
}

/** True for a script block argument: a word starting with `{`, as PowerShell reads one. */
export const isScriptBlock = (word: string): boolean => word.startsWith("{");

/** The words inside a script block `joinScriptBlocks` joined, without its braces. */
export const scriptBlockWords = (block: string): string[] =>
  block.replace(/^\{/, "").replace(/\}$/, "").split(/\s+/).filter(Boolean);

/** How many more `{` than `}` a word has. */
const braces = (word: string): number =>
  (word.match(/\{/g)?.length ?? 0) - (word.match(/\}/g)?.length ?? 0);

/** Redirect targets that write nothing anywhere (`2>/dev/null`, `> nul`, `> $null`). */
export const DISCARD = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null)$/i;

/** The program a command word names, lower-cased, without its directory or extension. */
export const binName = (token: string | undefined): string =>
  (token ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "") ?? "";
