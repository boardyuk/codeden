/**
 * Files that tools write or change through their operands (§11.2), beside the copies, downloads
 * and item cmdlets the classifier already reads: `dd of=x`, `ln -s a x` (the link is what is
 * written), `install`, `rsync`, `unzip -d`, `chmod`, `chown` and `chgrp`, `sed -i`, `truncate`, and
 * git's own outputs
 * (`git clone url x`, `git worktree add x`, `git diff --output=x`, `git format-patch -o x`,
 * `git archive -o x`). The risk classifier judges each as a write.
 */

/** The value of `--name=value` or `--name value` (also a short form, `-o value`, `-ovalue`). */
function optionValues(args: string[], long: string, short?: string): string[] {
  const out: string[] = [];
  for (const [i, arg] of args.entries()) {
    const next = args[i + 1];
    if (arg === long || (short && arg === short)) {
      if (next !== undefined) out.push(next);
    } else if (arg.startsWith(`${long}=`)) out.push(arg.slice(long.length + 1));
    else if (short && arg.startsWith(short) && !arg.startsWith("--")) out.push(arg.slice(2));
  }
  return out.filter(Boolean);
}

/** The words that aren't options, and not the values of the options in `valued`. */
function operands(args: string[], valued: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") return [...out, ...args.slice(i + 1)];
    if (valued.includes(arg)) i += 1;
    else if (!arg.startsWith("-") || arg === "-") out.push(arg);
  }
  return out;
}

/** True when `sed`'s words hold `-i` (`-i.bak`, a cluster such as `-ni`, `--in-place`). */
const editsInPlace = (args: string[]): boolean =>
  args.some((a) => /^--in-place(=|$)/.test(a) || /^-[a-zA-Z]*i/.test(a));

/** The files `bin` writes or changes through its operands; none for other programs. */
export function toolWrites(bin: string, args: string[]): string[] {
  if (bin === "dd") {
    return args.filter((a) => /^of=./i.test(a)).map((a) => a.slice(3));
  }
  if (bin === "ln") {
    const into = optionValues(args, "--target-directory", "-t");
    const names = operands(args, ["-t", "--target-directory", "-S", "--suffix"]);
    // One name links it into the current folder; with more, the last is the link or its folder.
    return [...into, ...(names.length > 1 ? names.slice(-1) : [])];
  }
  if (bin === "chmod" || bin === "chown" || bin === "chgrp") {
    const reference = args.some((a) => a.startsWith("--reference"));
    // The first operand is the mode or the owner, unless `--reference` gives it.
    return operands(args, ["--reference"]).slice(reference ? 0 : 1);
  }
  if (bin === "install" || bin === "rsync") {
    const into = optionValues(args, "--target-directory", bin === "install" ? "-t" : undefined);
    const names = operands(args, ["-t", "-m", "-o", "-g", "-e", "--mode", "--owner", "--group"]);
    // Not another machine's folder (`rsync . host:dir`).
    const local = (name: string) => !/^[^/\\]+:/.test(name);
    return [...into, ...(names.length > 1 ? names.slice(-1) : [])].filter(local);
  }
  if (bin === "unzip")
    return args.flatMap((a, i) => (a === "-d" && args[i + 1] ? [args[i + 1] as string] : []));
  if (bin === "truncate") return operands(args, ["-s", "--size", "-r", "--reference"]);
  if (bin === "sed" && editsInPlace(args)) {
    const scripted = args.some((a) => /^(-[a-zA-Z]*[ef]|--expression|--file)/.test(a));
    const valued = ["-e", "-f", "--expression", "--file", "-l", "--line-length"];
    return operands(args, valued).slice(scripted ? 0 : 1);
  }
  return [];
}

/** Git's global options that take the next word (`-C dir`, `-c name=value`). */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** Options of `git clone` and `git worktree add` that take the next word. */
const CLONE_VALUED = ["-b", "--branch", "-o", "--origin", "--depth", "-c", "--config", "-j"];
const CLONE_MORE = ["--reference", "--separate-git-dir", "--template", "-u", "--upload-pack"];
const WORKTREE_VALUED = ["-b", "-B", "--reason", "--orphan"];

/** The files and folders a git command writes outside its repository's own state. */
export function gitWrites(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]?.startsWith("-"))
    i += GIT_VALUED.has(args[i] as string) ? 2 : 1;
  const sub = args[i]?.toLowerCase();
  const rest = args.slice(i + 1);
  if (sub === "clone") {
    const names = operands(rest, [...CLONE_VALUED, ...CLONE_MORE]);
    return [...names.slice(1, 2), ...optionValues(rest, "--separate-git-dir")];
  }
  if (sub === "init") return operands(rest, ["-b", "--initial-branch", "--template"]).slice(0, 1);
  if (sub === "worktree" && rest[0]?.toLowerCase() === "add") {
    return operands(rest.slice(1), WORKTREE_VALUED).slice(0, 1);
  }
  if (sub === "format-patch") return optionValues(rest, "--output-directory", "-o");
  if (sub === "archive" || sub === "bundle") {
    const out = optionValues(rest, "--output", sub === "archive" ? "-o" : undefined);
    return sub === "bundle" && rest[0] === "create" ? [...out, ...rest.slice(1, 2)] : out;
  }
  // `git diff`, `git log`, `git show` and their kin write their output to `--output=file`.
  return optionValues(rest, "--output");
}
