/**
 * Paths an interpreter's one-liner may write (§11.2): `python -c`, `node -e`, `perl -e`,
 * `ruby -e`, `php -r`. Agents run such one-liners all the time, so they don't ask by themselves.
 * When the code uses a call that writes or deletes (`os.remove`, `shutil.rmtree`, `open(…, 'w')`,
 * `fs.rm`, `fs.writeFile`, `unlink`, ...), each string literal in it that is an absolute or
 * home-relative path is judged as a write: outside the worktree and the other writable folders
 * it asks, and in CodeDen's home it asks at every level.
 *
 * This is a heuristic over the text, not a reading of the code. It doesn't follow a path built at
 * run time (joined from parts, read from a variable, the environment or a file), a relative path
 * that climbs out (`'../..'`), or a script in a file or on standard input (`python - <<EOF`). And
 * it can't tell which literal the writing call uses, so a one-liner that reads one absolute path
 * and writes somewhere else asks too.
 */

/** Interpreters and the options their code follows. */
const CODE_FLAGS = new Map<string, RegExp>([
  ["python", /^-[a-zA-Z]*c$/],
  ["node", /^(-e|-p|-pe|--eval|--print)$/],
  ["bun", /^(-e|--eval|-p|--print)$/],
  ["deno", /^eval$/],
  ["perl", /^-[a-zA-Z0-9]*[eE]$/],
  ["ruby", /^-[a-zA-Z]*e$/],
  ["php", /^-r$/],
]);

/** `python3`, `python3.12`, `py`, `pypy3`, `nodejs` and the like, by their plain name. */
function interpreter(bin: string): string | undefined {
  if (/^(python|pypy)[\d.]*$|^py$/.test(bin)) return "python";
  if (bin === "nodejs") return "node";
  return CODE_FLAGS.has(bin) ? bin : undefined;
}

/** The code of an interpreter's one-liner (every `-c`/`-e` given), or none. */
export function inlineCode(bin: string, args: string[]): string[] {
  const flag = CODE_FLAGS.get(interpreter(bin) ?? "");
  if (!flag) return [];
  return args.flatMap((a, i) => (flag.test(a) && args[i + 1] ? [args[i + 1] as string] : []));
}

/** Calls and operators that write, change or delete files, across the interpreters. */
const WRITES = new RegExp(
  [
    String.raw`\b(remove|removedirs|unlink|rmdir|rmtree|remove_tree|rm_rf|rm_r|truncate)\w*\b`,
    String.raw`\b(mkdir|makedirs|mkdir_p|rename|symlink|chmod|chown)\w*\b`,
    String.raw`\b(writeFile|appendFile|copyFile|copytree|createWriteStream)\w*\b`,
    String.raw`\b(write_text|write_bytes|file_put_contents)\b`,
    String.raw`\.(rm|cp)(Sync)?\s*\(`,
    String.raw`\b(os\.replace|shutil\.(move|copy\w*)|File\.(write|delete|open)|FileUtils\.\w+)\b`,
    String.raw`(?<!stdout|stderr|res|socket)\.(write|touch)\s*\(`,
    String.raw`\bopen\s*\([^)]*,\s*(mode\s*=\s*)?["'][rwax+bt]*[wax+][rwax+bt]*["']`,
    String.raw`\bopen\s*\(?[^;]*["']\s*\+?>`,
  ].join("|"),
  "i",
);

/** A quoted string of path characters, without a line break. */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n\r])*)\1/g;
/**
 * An absolute or home-relative path: `/a/b`, `~/x`, `C:\x`, `C:/x`, `\\server\x`. A single name at
 * the root (`'/done'`, `'/'`) is more often a route or a separator than a file, so it doesn't count.
 */
const ROOTED = /^(?:~[\\/].|[a-zA-Z]:[\\/].|\\\\.|\/[^/]+\/.)/;
/** Not a path: a URL or a comment marker, a date or an HTML tag, text with spaces around it. */
const NOT_A_PATH = /^\/\/|:\/\/|^\/\s|[<>|*?"\n]|\s{2}/;

/**
 * The paths `code` may write: its rooted string literals, when it uses a writing call. Perl's
 * `open(F, '>/x')` names the file after its mode.
 */
export function inlineCodeWrites(code: string): string[] {
  if (!WRITES.test(code)) return [];
  const out: string[] = [];
  for (const match of code.matchAll(LITERAL)) {
    const text = (match[2] as string).replace(/\\([\\/"'])/g, "$1").replace(/^\+?>>?\s*/, "");
    if (ROOTED.test(text) && !NOT_A_PATH.test(text)) out.push(text);
  }
  return out;
}
