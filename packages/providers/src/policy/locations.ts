import { binName, CD, namedArg, unwrap } from "./command-words";
import {
  isKnownFolder,
  type PathContext,
  providerPath,
  resolveAgainst,
  type SavedLocation,
  UNKNOWN_DIR,
} from "./paths";
import type { SimpleCommand } from "./shell";

/**
 * Where relative paths resolve as a command line runs (§11.2). `cd`, `Set-Location` and their kin
 * move the location. A `cd` onto a PowerShell drive that isn't the filesystem (`cd HKCU:\Software`,
 * then `cd Foo`) moves relative paths there (`psDrive`) until a `cd` back to a folder.
 *
 * `pushd` and `Push-Location` save the location they leave on a stack, and `popd` and
 * `Pop-Location` go back to the latest one saved (#541). With nothing saved earlier in the command,
 * the shell's own stack is unknown, so the location stays. Named stacks (`-StackName x`) are kept
 * apart. `Set-Location -StackName x` makes another stack the default and `popd +N` drops an entry,
 * so both forget the stack and later pops stay where they are.
 */

const PUSH = new Set(["pushd", "push-location"]);
const POP = new Set(["popd", "pop-location"]);

/** The context after `cmd` when it changes location (`cd dir`, `Set-Location -Path dir`, `popd`). */
export function afterCd<T extends PathContext>(cmd: SimpleCommand, ctx: T): T {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  if (!CD.has(bin) && !POP.has(bin)) return ctx;
  const { stack, args } = withoutStackName(tokens.slice(1));
  if (POP.has(bin)) {
    if (args.some((a) => /^[+-]\d+$/.test(a))) return { ...ctx, pushed: undefined };
    return popLocation(ctx, stack);
  }
  const target = cdTarget(args);
  if (PUSH.has(bin)) {
    const saved: SavedLocation = { dir: ctx.dir, psDrive: ctx.psDrive, stack };
    // With no location, `Push-Location` saves the current one and stays.
    const moved = target === undefined ? ctx : moveTo(target, ctx);
    return { ...moved, pushed: [...(ctx.pushed ?? []), saved] };
  }
  if (stack !== undefined) return { ...ctx, pushed: undefined };
  return moveTo(target ?? "~", ctx);
}

/**
 * The context with its location moved to `target`: a folder, an item on a PowerShell drive, or a
 * folder only known when the command runs (`cd $X`, `cd -`: `UNKNOWN_DIR`, #614).
 */
export function moveTo<T extends PathContext>(target: string, ctx: T): T {
  const provider = providerPath(target, ctx);
  if (provider && provider.path === undefined) return { ...ctx, psDrive: provider.drive };
  const onDisk = { ...ctx, psDrive: undefined };
  const folder = provider?.path ?? target;
  if (!isKnownFolder(folder, onDisk)) return { ...onDisk, dir: UNKNOWN_DIR };
  return { ...onDisk, dir: resolveAgainst(folder, onDisk) };
}

/** Back to the latest location saved on `stack` (the default stack when undefined). */
function popLocation<T extends PathContext>(ctx: T, stack: string | undefined): T {
  const pushed = ctx.pushed ?? [];
  for (let k = pushed.length - 1; k >= 0; k -= 1) {
    const saved = pushed[k] as SavedLocation;
    if (saved.stack !== stack) continue;
    const rest = [...pushed.slice(0, k), ...pushed.slice(k + 1)];
    return { ...ctx, dir: saved.dir, psDrive: saved.psDrive, pushed: rest };
  }
  return ctx;
}

/**
 * The stack a `-StackName x` names (also a prefix, `-Stack x`, or bound, `-StackName:x`),
 * lower-cased, and the other words.
 */
function withoutStackName(args: string[]): { stack?: string; args: string[] } {
  const rest: string[] = [];
  let stack: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const param = /^-(s\w*)(?::(.*))?$/is.exec(arg);
    if (param && "stackname".startsWith((param[1] as string).toLowerCase())) {
      i += param[2] === undefined ? 1 : 0;
      stack = (param[2] ?? args[i] ?? "").toLowerCase();
    } else rest.push(arg);
  }
  return { stack, args: rest };
}

/** Bash's `cd` options (`-L`, `-P`, `-e`, `-@`), and the switches of `Set-Location` and its kin. */
const CD_FLAGS = /^-[LPe@]+$/;
const CD_SWITCHES = ["passthru", "verbose", "debug", "whatif", "confirm"];

/**
 * Where `cd`, `Set-Location` and their kin go, given their words without `-StackName`: `-Path x`,
 * or their one operand (cmd's `cd /d C:\dir` too, which also changes the drive; `/d` alone is Git
 * Bash's `D:\`). `-` (`./paths`' `isKnownFolder`) for a folder only known when it runs: `cd -`,
 * `pushd +1`, and two operands, as zsh's `cd old new` puts `new` for `old` in the current folder
 * (#614). A word after a parameter that isn't a switch (`-ErrorAction Stop`) is its value. None
 * for no folder.
 */
function cdTarget(args: string[]): string | undefined {
  // `pushd +1` and `pushd -1` rotate the stack, which may hold folders from earlier commands.
  if (args.some((a) => /^[+-]\d*$/.test(a))) return "-";
  const named = namedArg(args, ["-path", "-literalpath"]);
  if (named !== undefined) return named;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (i === 0 && args.length > 1 && /^\/d$/i.test(arg)) continue;
    if (!arg.startsWith("-")) operands.push(arg);
    else if (!CD_FLAGS.test(arg) && !arg.includes(":")) {
      const name = arg.slice(1).toLowerCase();
      if (!CD_SWITCHES.some((s) => s.startsWith(name))) i += 1;
    }
  }
  return operands.length > 1 ? "-" : operands[0];
}
