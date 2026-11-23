import { type RiskAssessment, risky } from "./assessment";
import { credentialsRisk, touchesCodedenHome } from "./codeden-home";
import { binName, unwrap } from "./command-words";
import { moveTo } from "./locations";
import { isTempRoot, isUnknownDir, isWritable, type PathContext } from "./paths";
import { programDenial } from "./read-only";
import { matchesLong } from "./read-only-options";
import type { SimpleCommand } from "./shell";

/**
 * Where a command runs (§11.2, #614). A command that changes something without naming a path
 * (`git reset --hard`, `make clean`, `npm install`) changes the folder it runs in: where a `cd`,
 * `pushd` or `Set-Location` earlier in the command line moved (`./locations`), or the folder a
 * program's own option names (`git -C dir`, `make -C dir`, `npm --prefix dir`, `env -C dir`, ...).
 * Outside the session's writable roots (the worktree, extra roots, temp and notes folders), such a
 * command asks as a write there, unless it only reads (`programDenial`, the read-only rules).
 * In CodeDen's own home, outside the session's own worktree, it asks at every level. A folder only
 * known when the command runs (`cd $X`, `cd -`) counts as outside.
 */

/** A program's options that name the folder it works in. */
interface FolderOptions {
  /** Short options naming a folder it moves to, relative to the last (`-C dir`, `-Cdir`, `-sC dir`). */
  short?: string;
  /** Short options that take a value, so the rest of their word (or the next word) is no option. */
  valued?: string;
  /** Long options naming a folder it moves to (`--directory dir`, `--directory=dir`, `--dir`). */
  long?: readonly string[];
  /** Long options naming another folder it changes (`git --git-dir`, `--work-tree`). */
  also?: readonly string[];
  /** Still works in the folder it was started in too (`tar -C` only moves what it extracts). */
  keepsBase?: true;
}

const MAKE: FolderOptions = { short: "C", valued: "fIoW", long: ["--directory"] };

const FOLDER_OPTIONS = new Map<string, FolderOptions>([
  ["git", { short: "C", valued: "c", also: ["--git-dir", "--work-tree"] }],
  ["make", MAKE],
  ["gmake", MAKE],
  ["npm", { short: "C", long: ["--prefix"] }],
  ["npx", { long: ["--prefix"] }],
  ["pnpm", { short: "C", long: ["--dir"] }],
  ["yarn", { long: ["--cwd"] }],
  ["bun", { long: ["--cwd"] }],
  ["go", { short: "C" }],
  ["ninja", { short: "C", valued: "fjklt" }],
  ["tar", { short: "C", valued: "fbFgHIKLNTVX", long: ["--directory"], keepsBase: true }],
]);

/** The variables that move git elsewhere (`GIT_DIR=../x/.git git reset --hard`). */
const GIT_FOLDER_VARS = /^(GIT_DIR|GIT_WORK_TREE)=(.*)$/s;

/** A folder option's value, by kind: a folder it moves to, or another folder it changes. */
interface FolderWord {
  word: string;
  moves: boolean;
}

/** The folder words in the arguments of a program with folder options (up to `--`). */
function folderWords(args: readonly string[], options: FolderOptions): FolderWord[] {
  const out: FolderWord[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const [name = "", ...rest] = arg.split("=");
      const long = options.long?.some((o) => matchesLong(name, o));
      const also = options.also?.some((o) => matchesLong(name, o));
      if (!long && !also) continue;
      const word = rest.length > 0 ? rest.join("=") : args[++i];
      if (word !== undefined) out.push({ word, moves: long === true });
    } else if (/^-[^-]/.test(arg)) {
      // A cluster of short options (`-sC dir`): the first that takes a value ends it.
      for (let k = 1; k < arg.length; k += 1) {
        const c = arg[k] as string;
        const folder = options.short?.includes(c) === true;
        if (!folder && !options.valued?.includes(c)) continue;
        const word = arg.slice(k + 1) || args[++i];
        if (folder && word !== undefined) out.push({ word, moves: true });
        break;
      }
    }
  }
  return out;
}

/**
 * The folders `cmd` runs or changes things in, as absolute paths (or `UNKNOWN_DIR`): where the
 * shell is, after `env -C`, then each folder its own options name. Every program in its words is
 * read, so a wrapper (`timeout 60 git -C …`, `xargs make -C …`) can't hide one.
 */
export function runFolders(cmd: SimpleCommand, ctx: PathContext): string[] {
  const { tokens, chdir, assigns } = unwrap(cmd.words);
  let base = ctx;
  for (const dir of chdir) base = moveTo(dir, base);
  const at = (c: PathContext) => c.dir ?? c.cwd;
  const out: string[] = [];
  let moved = false;
  for (const [k, token] of tokens.entries()) {
    const options = FOLDER_OPTIONS.get(binName(token));
    if (!options) continue;
    let here = base;
    for (const { word, moves } of folderWords(tokens.slice(k + 1), options)) {
      if (moves) here = moveTo(word, here);
      out.push(at(moves ? here : moveTo(word, here)));
    }
    moved ||= here !== base && !options.keepsBase;
  }
  for (const assign of assigns) {
    const git = GIT_FOLDER_VARS.exec(assign);
    if (git) out.push(at(moveTo(git[2] as string, base)));
  }
  return moved ? out : [at(base), ...out];
}

/**
 * The risk of `cmd` running where it runs (`runFolders`): undefined when it only reads, or every
 * folder it works in is the session's own (a temp folder itself included: what runs there writes
 * inside it). In CodeDen's own home, the risk every level asks about.
 */
export function folderRisk(cmd: SimpleCommand, ctx: PathContext): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  // Only assignments (`X=1`, PowerShell's `$x = 'a'` after `./ps-assignments`): nothing runs.
  if (tokens.length === 0 || !programDenial(binName(tokens[0]), tokens.slice(1))) return undefined;
  const all = runFolders(cmd, ctx);
  const dirs = all.filter((dir) => !isUnknownDir(dir));
  const home = dirs.find((dir) => touchesCodedenHome(dir, ctx));
  if (home !== undefined) return credentialsRisk(`Runs in CodeDen's own home: ${home}`);
  if (dirs.length < all.length) {
    return risky(
      "outside_worktree",
      "Runs in a folder only known when it runs, which may be outside the worktree",
    );
  }
  const outside = dirs.find((dir) => !isWritable(dir, ctx) && !isTempRoot(dir, ctx));
  return outside === undefined
    ? undefined
    : risky("outside_worktree", `Runs in ${outside}, outside the worktree`);
}

/** `folderRisk` when every level asks about it: a command run in CodeDen's own home. */
export function codedenFolderRisk(
  cmd: SimpleCommand,
  ctx: PathContext,
): RiskAssessment | undefined {
  const risk = folderRisk(cmd, ctx);
  return risk?.risky && risk.codeden ? risk : undefined;
}
