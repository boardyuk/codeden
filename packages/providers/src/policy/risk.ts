import { currentGitBranch } from "../util/git-head";
import { agentPermissionsCommand } from "./agent-permissions";
import { asksAtEveryLevel, mostSevere, type RiskAssessment, risky, SAFE } from "./assessment";
import { listOnlyReads, locationsThrough, ranLists, withFunctions } from "./blocks";
import { codedenCommand, pathsOf } from "./codeden-command";
import { binName, DISCARD, unwrap } from "./command-words";
import { copyWrites } from "./copies";
import { classifyDelete } from "./deletes";
import { downloadWrites } from "./downloads";
import { dumpsEnvironment } from "./env-dumps";
import { type ListOutput, namesOnly } from "./env-names";
import { classifyGit } from "./git";
import { inlineCode, inlineCodeCommands, inlineCodeWrites } from "./inline-code";
import { type InlineScript, inlineScripts } from "./inline-scripts";
import { classifyInstall } from "./installs";
import { itemWrites } from "./item-writes";
import { MAX_LOCATIONS, moveTo } from "./locations";
import { isInside, isSecretPath, isWin, resolveAgainst } from "./paths";
import { projectConfigCommand } from "./project-config";
import { providerLoginCommand } from "./provider-logins";
import { keptWords } from "./ps-assignments";
import { programDenial } from "./read-only";
import { registryChange, registryExports } from "./registry";
import { pipesDownloadIntoInterpreter } from "./remote-scripts";
import { codedenFolderRisk, folderRisk } from "./run-folder";
import { secretArgument, toolOutputs } from "./secrets";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";
import { classifyRead, classifyWrite, type RiskContext } from "./targets";
import { gitWrites, toolWrites } from "./write-tools";

export { classifyFetch, classifyGlob, classifyRead, classifyWrite } from "./targets";
/**
 * Risky-action classifier for the `auto` and `full` autonomy levels (§11.2). Provider-neutral:
 * adapters translate their tool calls into `classifyCommand` / `classifyWrite` /
 * `classifyRead` / `classifyFetch` calls. A risky result is turned into an approval request;
 * everything else runs freely. Writes inside the worktree, the extra roots and the OS temp
 * directory are not risky; secrets files are, wherever they are. This file judges command lines;
 * `./targets`, a file, a search or a fetch.
 */
export type { RiskAssessment, RiskContext };

/** How deep `bash -c "…"` style inline scripts are followed. */
const MAX_DEPTH = 4;

/** Why a script that isn't all written out asks (`eval "$CMD"`, `iex $x`; `./inline-scripts`). */
const UNKNOWN = "Runs a command that is only known when it runs";

/**
 * Classify a shell command (any shell: POSIX, PowerShell or cmd), in each way its shell may read
 * its escapes (`./shell-readings`). Downloads piped into an interpreter (`curl … | sh`,
 * `irm … | iex`) are found on the parsed pipeline in `classifyList`; here, a download run through
 * a substitution (`iex (irm …)`, `bash -c "$(curl …)"`, `bash <(curl …)`). CodeDen's own home and
 * credentials, then the agent CLIs' logins, are looked for first, across the whole command, so an
 * earlier ordinary risk (`cat .env; …`) can't hide them.
 */
export function classifyCommand(command: string, given: RiskContext): RiskAssessment {
  // `CDPATH` sends a `cd` to a relative folder anywhere it lists, and `GIT_DIR` or
  // `GIT_WORK_TREE` a `cd` to the repository's top folder elsewhere (#614).
  const ctx = {
    ...given,
    cdPath: given.cdPath || /\bCDPATH\b/.test(command),
    gitEnv: given.gitEnv || /\bGIT_(?:DIR|WORK_TREE)\b/.test(command),
  };
  // Every part is weighed, and the most severe verdict returned (#627): a risk Full allows (a
  // downloaded script, a force push) must not hide a later write outside the worktree.
  const found: RiskAssessment[] = [];
  if (
    /\b(iex|invoke-expression)\b[^|]*\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i.test(
      command,
    )
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  if (
    /\b(bash|sh|zsh)\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i.test(command) ||
    /<\(\s*(curl|wget)\b/i.test(command)
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  for (const list of shellReadings(command, ctx.shell ?? "auto", ctx)) {
    // What every level asks about, looked for across the whole command first: CodeDen's own home
    // and credentials (and a command run there), an agent CLI's login, then a write of an agent's
    // own allow-list.
    const always =
      firstInList(list, ctx, 0, codedenCommand) ??
      firstInList(list, ctx, 0, (cmd, here) => codedenFolderRisk(cmd, here)) ??
      firstInList(list, ctx, 0, (cmd, here) => providerLoginCommand(cmd, here)) ??
      firstInList(list, ctx, 0, (cmd, here) => agentPermissionsCommand(cmd, here));
    found.push(always ?? classifyList(list, ctx, 0));
  }
  return mostSevere(found);
}

/**
 * One simple command's verdict for `firstInList`. `feeds`: its output is used by another
 * command (it sits in a substitution or a pipe).
 */
type CommandCheck = (
  cmd: SimpleCommand,
  ctx: RiskContext,
  feeds: boolean,
) => RiskAssessment | undefined;

/**
 * The first verdict `check` gives anywhere in `list`: substitutions, subshells, blocks, called
 * functions (`./blocks`) and inline scripts (`bash -c "…"`) included, following `cd` like
 * `classifyList`.
 */
function firstInList(
  list: SimpleCommand[],
  given: RiskContext,
  depth: number,
  check: CommandCheck,
  feeds = false,
): RiskAssessment | undefined {
  let heres = [withFunctions(list, given)];
  let head = 0;
  for (const [i, cmd] of list.entries()) {
    if (!cmd.piped) head = i;
    const piped = list[i + 1]?.piped === true;
    for (const here of heres) {
      for (const nested of cmd.nested) {
        const found = firstInList(nested, here, depth, check, true);
        if (found) return found;
      }
      for (const ran of ranLists(cmd, here)) {
        const found = firstInList(ran.list, ran.ctx, depth, check, feeds || piped);
        if (found) return found;
      }
      const source = cmd.piped ? list[head] : undefined;
      for (const script of [...scriptsOf(cmd, depth, source), ...codeScripts(cmd, here, depth)]) {
        const into = feeds || piped || script.feeds === true;
        const there = scriptContext(script, cmd, here);
        for (const inner of shellReadings(script.text, script.dialect, there)) {
          const found = firstInList(inner, there, depth + 1, check, into);
          if (found) return found;
        }
      }
      for (const one of withKept(cmd)) {
        const found = check(one, here, feeds || piped);
        if (found) return found;
      }
    }
    heres = locationsThrough(cmd, heres);
    // A location past the limit isn't checked, so it may be CodeDen's home: every level asks.
    if (heres.length > MAX_LOCATIONS) return TOO_MANY_LOCATIONS;
  }
  return undefined;
}

/** A script nested deeper than is followed (`MAX_DEPTH`): what it runs isn't read. */
const TOO_DEEP: RiskAssessment = {
  risky: true,
  action: "outside_worktree",
  reason: "Runs a command nested too deep to read",
  always: true,
};

/** A command line that may leave the shell in more folders than are followed (`./locations`). */
const TOO_MANY_LOCATIONS: RiskAssessment = {
  risky: true,
  action: "outside_worktree",
  reason: "Changes folders in more ways than can be followed",
  always: true,
};

/**
 * Classify commands in order, and return the most severe verdict of them all (`mostSevere`), not
 * the first: Full allows some risks, and one of those must not hide a later one it asks about
 * (`git push --force && rm -rf ~/x`, #627). A `cd` moves where later relative paths resolve;
 * commands in substitutions and subshells are classified too, without their `cd` leaking out, and
 * so are those in blocks and called functions, whose `cd` may (`./blocks`). `output`: where the
 * list's output goes, which decides whether an environment listing that keeps only the names is a
 * dump (`./env-names`): substitutions hand theirs to another command, except a `(…).Name` group,
 * which keeps only the names itself.
 */
function classifyList(
  list: SimpleCommand[],
  given: RiskContext,
  depth: number,
  output: ListOutput = "shown",
): RiskAssessment {
  const found: RiskAssessment[] = [];
  if (pipesDownloadIntoInterpreter(list)) {
    found.push(risky("network", "Pipes a downloaded script straight into a shell"));
  }
  const names = namesOnly(list, output);
  // Where the shell may be: one location, unless a pop or a block may or may not happen.
  let heres = [withFunctions(list, given)];
  let head = 0;
  for (const [i, cmd] of list.entries()) {
    if (!cmd.piped) head = i;
    const shown = output === "shown" && list[i + 1]?.piped !== true;
    const source = cmd.piped ? list[head] : undefined;
    const at = { namesOnly: names.listings.has(i), shown, source };
    for (const here of heres) {
      for (const [k, nested] of cmd.nested.entries()) {
        const into = k === 0 && names.projections.has(i) ? "names" : "feeds";
        found.push(classifyList(nested, here, depth, into));
      }
      for (const ran of ranLists(cmd, here)) {
        found.push(classifyList(ran.list, ran.ctx, depth, shown ? "shown" : "feeds"));
      }
      for (const one of withKept(cmd)) found.push(classifySimple(one, here, depth, at));
    }
    heres = locationsThrough(cmd, heres);
    if (heres.length > MAX_LOCATIONS) return mostSevere([...found, TOO_MANY_LOCATIONS]);
  }
  return mostSevere(found);
}

/** `cmd`, then what a PowerShell assignment in it keeps in its variable (`keptWords`). */
function withKept(cmd: SimpleCommand): SimpleCommand[] {
  const kept = keptWords(cmd);
  return kept ? [cmd, kept] : [cmd];
}

/** The command lines `cmd` runs (`./inline-scripts`), while they are still followed. */
function scriptsOf(cmd: SimpleCommand, depth: number, source?: SimpleCommand): InlineScript[] {
  if (depth >= MAX_DEPTH) return [];
  const { tokens } = unwrap(cmd.words);
  return inlineScripts(binName(tokens[0]), tokens.slice(1), cmd, source);
}

/** True when `cmd` runs a script nested deeper than is followed, so what it runs isn't read. */
function tooDeep(cmd: SimpleCommand, depth: number, source?: SimpleCommand): boolean {
  return depth >= MAX_DEPTH && scriptsOf(cmd, 0, source).length > 0;
}

/**
 * The command lines the code of an interpreter's one-liner may run (`./inline-code`:
 * `python -c "os.system('…')"`), read from its string literals. A guess, so only what they write
 * or delete outside the worktree, and what every level asks about, counts.
 */
function codeScripts(cmd: SimpleCommand, ctx: RiskContext, depth: number): InlineScript[] {
  if (depth >= MAX_DEPTH) return [];
  const { tokens } = unwrap(cmd.words);
  const dialect = isWin(ctx) ? "auto" : "posix";
  return inlineCode(binName(tokens[0]), tokens.slice(1))
    .flatMap(inlineCodeCommands)
    .map((text) => ({ text, dialect }));
}

/**
 * Where an inline script of `cmd` runs: where `env -C` moved it (`env -C dir bash -c …`), then in
 * its own folder when it names one (`Start-Process -WorkingDirectory`), in a new process, which
 * starts with a location stack of its own.
 */
function scriptContext(script: InlineScript, cmd: SimpleCommand, ctx: RiskContext): RiskContext {
  let fresh: RiskContext = { ...ctx, pushed: undefined };
  for (const dir of unwrap(cmd.words).chdir) fresh = moveTo(dir, fresh);
  return script.dir ? moveTo(script.dir, fresh) : fresh;
}

/**
 * Where a simple command stands in its list. `namesOnly`: it lists the environment but only the
 * names reach the agent (`./env-names`). `shown`: its output reaches the agent, not another command.
 * `source`: when it reads a pipe, the command at the head of that pipeline (`./deletes`).
 */
interface Placement {
  namesOnly: boolean;
  shown: boolean;
  source?: SimpleCommand;
}

/**
 * One simple command's verdict. Anything but a read run outside the worktree asks as a write there
 * (`./run-folder`, #614), so Full asks too: that beats a risk Full lets through (a force push in
 * another repository), while a write outside the worktree the checks found keeps its own reason.
 * What a shell's inline script or `Start-Process` runs is judged where it runs instead, unless the
 * shell is handed another repository (`GIT_DIR=… bash -c …`), which its script would use.
 */
function classifySimple(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const verdict = classifyActions(cmd, ctx, depth, at);
  if (verdict.risky && (verdict.action === "outside_worktree" || asksAtEveryLevel(verdict))) {
    return verdict;
  }
  const scripts = scriptsOf(cmd, depth, at.source);
  const gitVars = unwrap(cmd.words).assigns.some((a) => /^GIT_(?:DIR|WORK_TREE)=/.test(a));
  return (scripts.length > 0 && !gitVars ? undefined : folderRisk(cmd, ctx)) ?? verdict;
}

/**
 * What one simple command does: the classifier's checks, wherever it runs. Every check is made,
 * and the most severe verdict returned: `sudo rm -rf ~/x` is a delete outside the worktree, not
 * only an elevated command, and so is the script an elevated `Start-Process` runs.
 */
function classifyActions(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const { tokens, elevated, chdir } = unwrap(cmd.words);
  const found: RiskAssessment[] = [];
  if (elevated) found.push(risky("other", "Runs a command with elevated privileges"));
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  // A block that never closes can't be read, so it asks unless the command only reads.
  if (cmd.unparsed && programDenial(bin, args) !== undefined) {
    found.push(risky("other", "Runs a block that never closes, so what it runs can't be read"));
  }

  // Inline scripts (`bash -c "…"`, `eval "…"`), the commands of cmd's `for` loop and what
  // Start-Process starts.
  const ran: RiskAssessment[] = [];
  for (const script of scriptsOf(cmd, depth, at.source)) {
    if (script.elevated) found.push(risky("other", "Runs a command with elevated privileges"));
    const output = at.shown && !script.feeds ? "shown" : "feeds";
    const there = scriptContext(script, cmd, ctx);
    const lists = shellReadings(script.text, script.dialect, there);
    for (const list of lists) ran.push(classifyList(list, there, depth + 1, output));
    if (script.dynamic && !lists.every(listOnlyReads))
      ran.push(risky("other", `${UNKNOWN} (${bin})`));
  }
  if (tooDeep(cmd, depth, at.source)) found.push(TOO_DEEP);
  for (const script of codeScripts(cmd, ctx, depth)) {
    for (const list of shellReadings(script.text, script.dialect, ctx)) {
      const guess = classifyList(list, ctx, depth + 1, "feeds");
      if (guess.risky && guess.action === "outside_worktree") ran.push(guess);
    }
  }
  // A risk that was read comes before one that is only "unknown".
  const unknown = (r: RiskAssessment) => r.risky && r.reason.startsWith(UNKNOWN);
  found.push(...ran.filter((r) => !unknown(r)), ...ran.filter(unknown));

  for (const target of cmd.writes) {
    if (!DISCARD.test(target)) found.push(classifyWrite(target, ctx));
  }
  // Where `sudo -D dir` or `env -C dir` runs it, its own paths resolve.
  const here = chdir.reduce((at, dir) => moveTo(dir, at), ctx);

  if (bin === "git") {
    const verdict = classifyGit(args, {
      ownBranch: ctx.ownBranch,
      currentBranch: ctx.currentBranch ?? (() => currentGitBranch(ctx.cwd)),
      inWorktree: isInside(resolveAgainst(".", ctx), ctx.cwd, ctx),
    });
    // `git checkout <ref> -- .codeden/project.json` writes CodeDen's project config.
    found.push(verdict.risky ? verdict : (projectConfigCommand(cmd, ctx) ?? SAFE));
    for (const target of gitWrites(args)) found.push(classifyWrite(target, here));
    return mostSevere(found);
  }

  found.push(
    classifyInstall(
      bin,
      args.map((a) => a.toLowerCase()),
    ),
  );
  found.push(classifyDelete(cmd, ctx, at.source));
  const registry = registryChange(bin, args, tokens);
  if (registry) found.push(registry);

  const copies = copyWrites(bin, args, ctx);
  const outputs = [...toolOutputs(bin, args), ...registryExports(bin, args)];
  const items = itemWrites(cmd, ctx, at.source);
  const downloads = downloadWrites(cmd, ctx);
  const written = [...copies.words, ...outputs, ...items.words, ...downloads.words];
  const targets = [...copies.targets, ...outputs, ...items.targets, ...downloads.targets];
  for (const target of targets) found.push(classifyWrite(target, ctx));
  for (const target of toolWrites(bin, args)) found.push(classifyWrite(target, here));
  // A one-liner's code: the rooted paths it names, when it writes or deletes (`./inline-code`).
  for (const code of inlineCode(bin, args)) {
    for (const target of inlineCodeWrites(code)) {
      const write = classifyWrite(target, here);
      if (write.risky && write.action !== "file_change") found.push(write);
    }
  }

  // A file PowerShell's variable syntax reads (`${C:\Users\me\.ssh\id_rsa}`), whatever the command.
  for (const item of cmd.reads ?? []) found.push(classifyRead(item, ctx));

  // Secrets: any argument (or element of a PowerShell list) that reads a credentials file.
  const secret = secretArgument(bin, args, written, isSecretPath, pathsOf(cmd));
  if (secret) found.push(risky("secrets", `Accesses the secrets file ${secret}`));

  if (!at.namesOnly && dumpsEnvironment(bin, args)) {
    found.push(risky("secrets", "Dumps environment variables"));
  }
  // CodeDen's project config: `sed -i`, `git checkout --` and inline code reach it too.
  found.push(projectConfigCommand(cmd, ctx) ?? SAFE);
  return mostSevere(found);
}
