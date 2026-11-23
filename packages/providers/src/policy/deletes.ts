import { type RiskAssessment, risky, SAFE } from "./assessment";
import { binName, unwrap } from "./command-words";
import { isWritable, type PathContext, providerPath, SHELL_DRIVES } from "./paths";
import { type SimpleCommand, wordPaths } from "./shell";

/**
 * Deletes outside the worktree (§11.2). `rm`, `del`, `Remove-Item` and their kin ask when they
 * name the filesystem root or a path outside where the agent may write (the worktree, the extra
 * roots, a folder in the OS temp directory). So do `xargs rm …` and a `ForEach-Object` block that
 * runs `Remove-Item`.
 *
 * A delete fed by a pipe (#449) removes what the pipeline hands it: `Get-ChildItem C:\Users |
 * Remove-Item -Recurse` deletes in `C:\Users` like `Remove-Item -Recurse C:\Users\*` does, and so
 * do `… | ForEach-Object { Remove-Item $_ }` and `… | xargs rm`. The command at the head of the
 * pipeline is checked: the paths it names, or the current directory for a listing that names
 * none (`Get-ChildItem -Recurse`, `find -name x`). Stages in between (`Where-Object`, `grep`,
 * `Select-Object -First 5`) only pass items on, and are not read as paths.
 *
 * A search that deletes what it finds (#518: `find X -delete`, `find X -exec rm {} +`,
 * `fd . X -x rm`) deletes under the folders it searches, like `find X | xargs rm`. A registry key
 * or certificate (`Remove-Item HKCU:\Software\Foo`, or `Remove-Item Foo` after
 * `cd HKCU:\Software`) is never in the worktree; PowerShell's `Env:`, `Variable:`, `Function:` and
 * `Alias:` drives only hold the running shell's own state, so deleting there runs freely.
 * `reg delete` is judged with the other `reg` commands (`./registry`).
 */

/** Commands that delete the paths they are given. */
const DELETES = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
  "remove-itemproperty",
  "rp",
  "unlink",
  "shred",
]);
/** Listings: what they output lies under the paths they name, or the current directory. */
const LISTINGS = new Set(["get-childitem", "gci", "ls", "dir", "get-item", "gi", "find"]);
/** Listing parameters whose value is a pattern or a number, not a path. */
const PATTERN_PARAMS = new Set(["-filter", "-include", "-exclude", "-depth", "-attributes"]);
/** `xargs` options that take the next word as their value. */
const XARGS_VALUED = new Set([
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);
const FOREACH = new Set(["foreach-object", "%", "foreach"]);

/** `find`'s actions that run a command on what it finds. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** `fd`'s options that run a command on what it finds: the words after them, up to `;`. */
const FD_RUNS = new Set(["--exec", "--exec-batch"]);
/** `fd`'s options whose value is a folder it searches. */
const FD_ROOTS = new Set(["--search-path", "--base-directory"]);
/** `fd`'s other long options that take the next word as their value. */
const FD_VALUED = new Set([
  "--extension",
  "--type",
  "--max-depth",
  "--maxdepth",
  "--min-depth",
  "--exact-depth",
  "--exclude",
  "--threads",
  "--color",
  "--size",
  "--changed-within",
  "--changed-before",
  "--change-newer-than",
  "--change-older-than",
  "--newer",
  "--older",
  "--owner",
  "--ignore-file",
  "--max-results",
  "--path-separator",
  "--batch-size",
  "--format",
  "--and",
  "--max-buffer-time",
]);
/** `fd`'s short options that take a value (`-e log`, `-elog`). */
const FD_VALUED_SHORT = "deEtjcSo";

/**
 * The delete risk of `cmd`: the paths it deletes itself and, when it reads a pipe, those the
 * command at the head of its pipeline (`source`) lists or names.
 */
export function classifyDelete(
  cmd: SimpleCommand,
  ctx: PathContext,
  source?: SimpleCommand,
): RiskAssessment {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  if (bin === "find" || bin === "fd") return searchDelete(cmd, bin, args, ctx);
  const own = deletedPaths(cmd, bin, args);
  if (!own) return SAFE;
  for (const target of own) {
    const where = outside(target, ctx);
    if (where !== undefined) return risky("outside_worktree", `Deletes ${target}${where}`);
  }
  if (!source) return SAFE;
  for (const target of listedPaths(source)) {
    const where = outside(target, ctx);
    if (where !== undefined) {
      return risky("outside_worktree", `Deletes what a pipe lists from ${target}${where}`);
    }
  }
  return SAFE;
}

/**
 * Why deleting `target` asks: `""` for the filesystem root, `", outside the worktree"` for a path
 * the agent may not write, a registry key or a certificate. Undefined when it may delete it. `*`
 * empties the current directory: fine in the worktree or a folder in temp.
 */
function outside(target: string, ctx: PathContext): string | undefined {
  const provider = providerPath(target, ctx);
  if (provider?.path !== undefined) return outside(provider.path, ctx);
  if (provider) return SHELL_DRIVES.has(provider.drive) ? undefined : ", outside the worktree";
  if (/^[\\/]$/.test(target) || /^[a-z]:[\\/]?$/i.test(target)) return "";
  return isWritable(target === "*" ? "." : target, ctx) ? undefined : ", outside the worktree";
}

/** The paths `cmd` deletes by name, or undefined when it deletes nothing. */
function deletedPaths(cmd: SimpleCommand, bin: string, args: string[]): string[] | undefined {
  if (DELETES.has(bin)) return operands(cmd, args);
  if (bin === "xargs") {
    const inner = unwrap(xargsCommand(args)).tokens;
    return DELETES.has(binName(inner[0])) ? operands(cmd, inner.slice(1)) : undefined;
  }
  if (FOREACH.has(bin)) {
    // The words of `{ Remove-Item $_.FullName -Recurse }`, without the braces.
    const words = args.map((w) => w.replace(/^\{+/, "").replace(/[};]+$/, "")).filter(Boolean);
    const at = words.findIndex((w) => DELETES.has(w.toLowerCase()));
    return at >= 0 ? operands(cmd, words.slice(at + 1)) : undefined;
  }
  return undefined;
}

/**
 * The risk of a `find` or `fd` that deletes what it finds (`-delete`, or a delete command run by
 * `-exec`, `-execdir`, `-ok`, `-okdir`, `fd -x`, `fd -X`): it deletes under the folders it
 * searches, the current directory when it names none. The paths the delete command names itself
 * (`-exec rm -rf /var/cache/{} \;`) are checked too.
 */
function searchDelete(
  cmd: SimpleCommand,
  bin: string,
  args: string[],
  ctx: PathContext,
): RiskAssessment {
  const search = bin === "find" ? readFind(args) : readFd(args);
  let deletes = search.deletes;
  const named: string[] = [];
  for (const run of search.runs) {
    const inner = unwrap(run).tokens;
    if (!DELETES.has(binName(inner[0]))) continue;
    deletes = true;
    named.push(...operands(cmd, inner.slice(1)).filter((p) => p !== "{}"));
  }
  if (!deletes) return SAFE;
  for (const root of search.roots.length > 0 ? search.roots : ["."]) {
    const where = outside(root, ctx);
    if (where !== undefined) {
      return risky("outside_worktree", `Deletes what ${bin} finds in ${root}${where}`);
    }
  }
  for (const target of named) {
    const where = outside(target, ctx);
    if (where !== undefined) return risky("outside_worktree", `Deletes ${target}${where}`);
  }
  return SAFE;
}

/** What a search reads: the folders it searches, the commands it runs, whether it deletes. */
interface Search {
  roots: string[];
  runs: string[][];
  deletes: boolean;
}

/** `find path… expression`: its paths, its `-exec` style commands and its `-delete`. */
function readFind(args: string[]): Search {
  const runs: string[][] = [];
  let deletes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "-delete") deletes = true;
    else if (FIND_RUNS.has(arg)) {
      const end = runEnd(args, i + 1);
      runs.push(args.slice(i + 1, end));
      i = end;
    }
  }
  return { roots: findPaths(args), runs, deletes };
}

/**
 * `fd [options] [pattern] [path…]`: the paths (and `--search-path`, `--base-directory`), and the
 * commands of `-x`/`--exec` and `-X`/`--exec-batch`, which take every word after them up to `;`.
 */
function readFd(args: string[]): Search {
  const positional: string[] = [];
  const roots: string[] = [];
  const runs: string[][] = [];
  const run = (first: string, from: number): number => {
    const end = runEnd(args, from);
    runs.push([...(first ? [first] : []), ...args.slice(from, end)]);
    return end;
  };
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!options || !arg.startsWith("-") || arg === "-") {
      positional.push(arg);
    } else if (arg === "--") {
      options = false;
    } else if (arg.startsWith("--")) {
      const [name = "", ...value] = arg.split("=");
      const bound = value.length > 0 ? value.join("=") : undefined;
      if (FD_RUNS.has(name)) i = run(bound ?? "", i + 1);
      else if (FD_ROOTS.has(name)) roots.push(bound ?? (args[++i] as string));
      else if (FD_VALUED.has(name) && bound === undefined) i += 1;
    } else {
      // Short options, bundled or not (`-HIx rm`, `-elog`): `-x`/`-X` run the rest of the word
      // and the words after it; a valued one takes the rest of the word or the next word.
      for (let c = 1; c < arg.length; c += 1) {
        const ch = arg[c] as string;
        if (ch === "x" || ch === "X") {
          i = run(arg.slice(c + 1), i + 1);
          break;
        }
        if (FD_VALUED_SHORT.includes(ch)) {
          if (c === arg.length - 1) i += 1;
          break;
        }
      }
    }
  }
  return { roots: [...roots, ...positional.slice(1)].filter(Boolean), runs, deletes: false };
}

/**
 * Where a command run by `find -exec` or `fd -x` ends: at a `;` word, or (`find`'s batch form)
 * a `+` right after `{}`. The index of the terminator, or the end of the words.
 */
function runEnd(args: string[], from: number): number {
  for (let k = from; k < args.length; k += 1) {
    const word = args[k] as string;
    if (word === ";" || word === "\\;" || (word === "+" && args[k - 1] === "{}")) return k;
  }
  return args.length;
}

/** The command `xargs` runs: the words after its options. */
function xargsCommand(args: string[]): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-")) return args.slice(i);
    if (XARGS_VALUED.has(arg)) i += 1;
  }
  return [];
}

/**
 * The paths a command lists or names, for the delete (or item write, `./item-writes`) it feeds. A
 * listing that names none lists the current directory. `find`'s paths are the words before its
 * expression.
 */
export function listedPaths(source: SimpleCommand): string[] {
  const { tokens } = unwrap(source.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const paths =
    bin === "find"
      ? findPaths(args)
      : operands(
          source,
          args.filter((_, k) => !PATTERN_PARAMS.has(args[k - 1]?.toLowerCase() ?? "")),
        );
  return paths.length > 0 || !LISTINGS.has(bin) ? paths : ["."];
}

/** `find [-H|-L|-P] [-D x] [-O1] path… expression`: the paths. */
export function findPaths(args: string[]): string[] {
  let k = 0;
  while (k < args.length && /^-([HLP]|D|O\d*)$/.test(args[k] as string)) {
    k += args[k] === "-D" ? 2 : 1;
  }
  const rest = args.slice(k);
  const end = rest.findIndex((a) => /^[-(!)]/.test(a));
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The path words among `args`: not options or cmd switches (`/s`), with PowerShell's bound
 * `-Path:x` and `-LiteralPath:x`, and each element of a PowerShell list (`a,b`).
 */
function operands(cmd: SimpleCommand, args: string[]): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    const bound = /^-(path|literalpath|lp):/i.exec(arg);
    if (bound) paths.push(...wordPaths(cmd, arg, bound[0].length));
    else if (!arg.startsWith("-") && !/^\/[a-z]$/i.test(arg)) paths.push(...wordPaths(cmd, arg));
  }
  return paths;
}
