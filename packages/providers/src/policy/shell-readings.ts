import { isWin, type PathContext } from "./paths";
import { parseShell, type ShellDialect, type SimpleCommand } from "./shell";
import type { EscapeMode } from "./shell-escapes";

/**
 * The ways a command line may be read (§11.2), by how its shell reads escapes (`./shell-escapes`).
 * The risk classifier judges each reading and keeps the most severe verdict, so an escape can't
 * make a command look as if it stays in the worktree when the shell that runs it would leave it.
 *
 * - PowerShell: backslashes are separators (its backtick escape is read by the lexer).
 * - A POSIX shell: escapes are taken out. On Windows (Git Bash) the command is also read as
 *   written, so a Windows path keeps its separators.
 * - A shell that isn't known: as written, as PowerShell and cmd read it, and the POSIX way. On
 *   Windows the POSIX reading is the careful one, which leaves ordinary Windows paths alone, and
 *   cmd's `^` escapes are read too.
 */
export function shellReadings(
  src: string,
  dialect: ShellDialect,
  ctx: PathContext,
): SimpleCommand[][] {
  return escapeModes(src, dialect, isWin(ctx)).map((mode) => parseShell(src, dialect, mode));
}

function escapeModes(src: string, dialect: ShellDialect, win: boolean): EscapeMode[] {
  if (dialect === "powershell") return ["keep"];
  // `$'…'` is read with the backslashes.
  const escapes = src.includes("\\") || src.includes("$'");
  if (dialect === "posix") return win && escapes ? ["posix", "keep"] : ["posix"];
  const modes: EscapeMode[] = ["keep"];
  if (escapes) modes.push(win ? "careful" : "posix");
  if (win && src.includes("^")) modes.push("caret");
  return modes;
}
