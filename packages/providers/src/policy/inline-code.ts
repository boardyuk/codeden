/**
 * Paths an interpreter's one-liner may write (§11.2): `python -c`, `node -e`, `perl -e`,
 * `ruby -e`, `php -r`. Agents run such one-liners all the time, so they don't ask by themselves.
 * When the code uses a call that writes or deletes (`os.remove`, `shutil.rmtree`, `open(…, 'w')`,
 * `fs.rm`, `fs.writeFile`, `unlink`, ...), each string literal in it that is an absolute or
 * home-relative path is judged as a write: outside the worktree and the other writable folders
 * it asks, and in CodeDen's home it asks at every level.
 *
 * When it runs a command (`os.system`, `subprocess.run`, `execSync`, `system`), its string
 * literals are also read as command lines, and judged like the script of `bash -c`.
 *
 * This is a heuristic over the text, not a reading of the code. It doesn't follow a path or a
 * command built at run time (joined from parts, read from a variable, the environment or a file),
 * or a script in a file or on standard input (`python - <<EOF`). And it can't tell which literal
 * the writing call uses, so a one-liner that reads one absolute path and writes somewhere else
 * asks too.
 */

/** Interpreters and the options their code follows. */
const CODE_FLAGS = new Map<string, RegExp>([
  ["python", /^-[a-zA-Z]*c$/],
  ["node", /^(-e|-p|-pe|--eval|--print)$/],
  ["tsx", /^(-e|--eval)$/],
  ["ts-node", /^(-e|-p|-pe|--eval|--print)$/],
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

/** The code of an interpreter's one-liner (every `-c`/`-e` given, also `--eval=code`), or none. */
export function inlineCode(bin: string, args: string[]): string[] {
  const flag = CODE_FLAGS.get(interpreter(bin) ?? "");
  if (!flag) return [];
  return args.flatMap((a, i) => {
    const bound = /^(--eval|--print)=(.+)$/s.exec(a);
    if (bound?.[2] && flag.test(bound[1] as string)) return [bound[2]];
    return flag.test(a) && args[i + 1] ? [args[i + 1] as string] : [];
  });
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
 * A path that may lie outside the worktree: absolute or home-relative (`/a`, `/a/b`, `~/x`,
 * `C:\x`, `C:/x`, `\\server\x`), or climbing out of a folder (`../x`). Not `'/'` alone, which is
 * more often a separator.
 */
const ROOTED = /^(?:~[\\/].|[a-zA-Z]:[\\/].|\\\\.|\/[^/\s]|\.\.(?:[\\/]|$))/;
/** Not a path: a URL or a comment marker, a pattern or an HTML tag, text with spaces around it. */
const NOT_A_PATH = /^\/\/|:\/\/|^\/\s|[<>|*?"^$\n]|\s{2}/;
/**
 * Calls whose strings are text, not files: `s.replace('/api/v1', '/api/v2')`, `print('/done')`.
 * They are left out before the literals are read.
 */
const TEXT_CALLS =
  /(?:\.(?:replace(?:All)?|split|join|startsWith|endsWith|startswith|endswith|includes|indexOf|g?sub|strip\w*|trim\w*)|\b(?:print|puts|echo|console\.\w+))\s*\((?:[^()]|\([^()]*\))*\)/g;

/**
 * The paths `code` may write: its rooted string literals, when it uses a writing call. Perl's
 * `open(F, '>/x')` names the file after its mode.
 */
export function inlineCodeWrites(code: string): string[] {
  if (!WRITES.test(code)) return [];
  const out: string[] = [];
  const read = code.replace(TEXT_CALLS, "");
  for (const match of read.matchAll(LITERAL)) {
    const text = unquoted(match[2] as string).replace(/^\+?>>?\s*/, "");
    if (!ROOTED.test(text) || NOT_A_PATH.test(text)) continue;
    // A single name at the root (`'/about'`) is more often a route than a file, unless a call is
    // handed it (`rmtree('/home')`, `unlink "/home"`).
    const handed = /[(\w]\s*$/.test(read.slice(0, match.index));
    if (handed || !/^\/[^/]+\/?$/.test(text)) out.push(text);
  }
  return out;
}

/** A string literal's text, without the escapes of its quotes and separators. */
const unquoted = (body: string): string => body.replace(/\\([\\/"'])/g, "$1");

/** The text of each string literal in `code`, in order. */
const literals = (code: string): string[] =>
  [...code.matchAll(LITERAL)].map((m) => unquoted(m[2] as string));

/** Calls that run a command: `os.system`, `subprocess.run`, `execSync`, `spawn`, `system`. */
const RUNS = /\b(system|popen\w*|exec\w*|spawn\w*|subprocess|check_call|check_output|passthru)\b/i;
/** A word a shell reads as it is written. */
const PLAIN_WORD = /^[\w@%+=:,./\\~-]+$/;
/** More literals than this are read one by one only. */
const MAX_WORDS = 24;

/**
 * The command lines `code` may run, when it uses a call that runs one: each string literal with a
 * space in it (`os.system('rm -rf x')`), and each run of literals from a program's name on, as
 * the words of one command (`subprocess.run(['rm', '-rf', 'x'])`, `execFileSync('rm', ['x'])`).
 */
export function inlineCodeCommands(code: string): string[] {
  if (!RUNS.test(code)) return [];
  const found = literals(code);
  const out = found.filter((text) => /\S\s+\S/.test(text));
  if (found.length > MAX_WORDS) return out;
  const words = found.map((w) => (PLAIN_WORD.test(w) ? w : `'${w.replace(/'/g, "")}'`));
  for (const [i, word] of found.entries()) {
    if (i < found.length - 1 && PLAIN_WORD.test(word)) out.push(words.slice(i).join(" "));
  }
  return out;
}
