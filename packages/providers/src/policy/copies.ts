import { isScriptBlock, joinScriptBlocks, namedArg, scriptBlockWords } from "./command-words";
import { isTempRoot, type PathContext } from "./paths";

/**
 * Where a copy, move or file-writing command writes (§11.2): `cp`, `mv`, cmd's `copy`, `move`,
 * `xcopy` and `robocopy`, PowerShell's `Copy-Item` and `Move-Item`, and `tee`, `Set-Content`,
 * `Out-File` and `Add-Content`.
 */

const COPIES = ["cp", "mv", "copy", "move", "copy-item", "move-item", "xcopy", "robocopy"];
const WRITERS = ["tee", "set-content", "out-file", "add-content"];
/** cmd-style copies, whose `/X` words are switches; for `cp` and `mv`, `/tmp` is a path. */
const CMD_COPIES = ["copy", "move", "xcopy", "robocopy"];

/** What a copy or write writes: the paths to judge, and the words naming them that read nothing. */
export interface CopyWrites {
  targets: string[];
  words: string[];
}

/**
 * The destination of a copy, move or write. One a script block computes (`-Destination
 * { 'C:\Old\' + $_.Name }`) may be named by any of its words.
 */
export function copyWrites(bin: string, args: string[], ctx: PathContext): CopyWrites {
  const dest = copyDestination(bin, args);
  if (dest === undefined) return { targets: [], words: [] };
  if (isScriptBlock(dest)) {
    const words = scriptBlockWords(dest).filter((w) => !w.startsWith("-"));
    return { targets: words, words };
  }
  return { targets: copyTargets(bin, args, dest, ctx), words: [dest] };
}

/** The path-like words of a copy or write: not options, nor cmd switches (`/E`, `/R:3`). */
function operands(bin: string, args: string[]): string[] {
  return args.filter(
    (a) => !a.startsWith("-") && !(CMD_COPIES.includes(bin) && /^\/[a-z]+(:\S*)?$/i.test(a)),
  );
}

/** Where a copy, move or file-writing command writes: a path, or a script block computing one. */
function copyDestination(bin: string, words: string[]): string | undefined {
  if (!COPIES.includes(bin) && !WRITERS.includes(bin)) return undefined;
  const args = joinScriptBlocks(words);
  const named = WRITERS.includes(bin)
    ? namedArg(args, ["-path", "-filepath", "-literalpath"])
    : namedArg(args, ["-destination"]);
  if (named) return named;
  const positional = operands(bin, args);
  return (WRITERS.includes(bin) ? positional[0] : positional.at(-1)) || undefined;
}

/**
 * The paths a copy or write lands on. A copy into a temp directory itself (`cp a.png /tmp/`)
 * writes the copied names inside it, so they are checked instead (a secrets file there asks).
 */
function copyTargets(bin: string, args: string[], dest: string, ctx: PathContext): string[] {
  if (!COPIES.includes(bin) || !isTempRoot(dest, ctx)) return [dest];
  const sources = operands(bin, args).filter((a) => a !== dest);
  const names = sources
    .map(
      (s) =>
        s
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? "",
    )
    .filter(Boolean);
  return names.length ? names.map((name) => `${dest.replace(/[\\/]+$/, "")}/${name}`) : [dest];
}
