/**
 * Programs that run another command (§11.2): elevation (`sudo -u root rm …`) and wrappers
 * (`timeout 9 rm …`, `nice -n 5 rm …`, `busybox rm …`). `./command-words`' `unwrap` skips their
 * own options, with the values those take, so the classifier judges the command they run. They are
 * recognised by basename (`/usr/bin/sudo`, `timeout.exe`).
 */

interface WrapperSpec {
  /** Short options that take a value (`-u root`, or attached, `-uroot`). */
  short?: string;
  /** Long options that take a value in the next word (`--user root`; `--user=root` needs none). */
  long?: readonly string[];
  /** Operands of its own before the command: `timeout`'s duration. */
  operands?: number;
  /** The option that names the folder the command runs in (`sudo -D dir`). */
  chdir?: { short: string; long: string };
  /** Options that make it describe a command instead of running it (`command -v git`). */
  describes?: string;
  /** Options start with `/` (Windows' `runas /user:x`). */
  slash?: boolean;
  /** Its words are one command line, which it hands a shell (`watch 'rm -rf x'`). */
  shell?: boolean;
  /** The option whose value is a command line for a shell (`su -c '…'`, `flock file -c '…'`). */
  command?: { short: string; long: string };
}

const SUDO: WrapperSpec = {
  short: "ugChpDTrtUR",
  long: [
    "--user",
    "--group",
    "--close-from",
    "--host",
    "--prompt",
    "--chdir",
    "--command-timeout",
    "--role",
    "--type",
    "--other-user",
    "--chroot",
  ],
  chdir: { short: "D", long: "--chdir" },
};

/** Programs that run a command with other privileges. */
const ELEVATORS = new Map<string, WrapperSpec>(
  Object.entries({
    sudo: SUDO,
    gsudo: SUDO,
    doas: { short: "uC" },
    pkexec: { long: ["--user"] },
    runas: { slash: true },
    // `su [options] [-] [user]`: only `-c` gives it a command.
    su: {
      short: "gGsw",
      long: ["--group", "--supp-group", "--shell", "--whitelist-environment"],
      command: { short: "c", long: "--command" },
    },
  }),
);

/** Programs that run a command as it is. */
const WRAPPERS = new Map<string, WrapperSpec>(
  Object.entries({
    command: { describes: "vV" },
    builtin: {},
    exec: { short: "a" },
    nohup: {},
    setsid: {},
    time: { short: "of", long: ["--output", "--format"] },
    timeout: { short: "sk", long: ["--signal", "--kill-after"], operands: 1 },
    nice: { short: "n", long: ["--adjustment"] },
    ionice: { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] },
    stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
    // The first word is the applet: `busybox rm -rf x`.
    busybox: {},
    toybox: {},
    // `shx rm -rf x` runs the shell command it names.
    shx: {},
    unbuffer: {},
    // `flock [options] file command…`, or `flock file -c 'command line'`.
    flock: {
      short: "wE",
      long: ["--wait", "--timeout", "--conflict-exit-code"],
      operands: 1,
      command: { short: "c", long: "--command" },
    },
    chroot: { long: ["--userspec", "--groups"], operands: 1 },
    strace: { short: "abeEIoOpPsSuUX", long: ["--output", "--trace", "--attach", "--user"] },
    ltrace: { short: "aAbeDlnopsux", long: ["--output"] },
    watch: { short: "n", long: ["--interval"], shell: true },
    taskset: { short: "c", long: ["--cpu-list"] },
  }),
);

/** `sh -c` given `line`, as the wrappers that hand a shell one command line run it. */
const inShell = (line: string): string[] => ["sh", "-c", line];

/** True for a program that runs a command with other privileges (`sudo`, `doas`, `runas`). */
export const elevates = (bin: string): boolean => ELEVATORS.has(bin);

/**
 * The command `bin` runs, given the words after it: those after its options and operands. Empty
 * when it runs none (`sudo -v`); undefined when `bin` is no wrapper, or only describes a command
 * (`command -v git`). Folders it moves into are added to `chdir`.
 */
export function wrappedCommand(bin: string, args: string[], chdir: string[]): string[] | undefined {
  const spec = ELEVATORS.get(bin) ?? WRAPPERS.get(bin);
  if (!spec) return undefined;
  if (spec.command) {
    const { short, long } = spec.command;
    const at = args.findIndex((a) => a === `-${short}` || a === long || a.startsWith(`${long}=`));
    const arg = args[at] ?? "";
    const given = arg.includes("=") ? arg.slice(long.length + 1) : args[at + 1];
    if (at >= 0 && given !== undefined) return inShell(given);
  }
  // `taskset -c 0,1 command`: the list of CPUs is the option's value, and no mask follows.
  let operands = spec.operands ?? (bin === "taskset" ? 1 : 0);
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (spec.slash && arg.startsWith("/")) continue;
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) {
      const [name = "", ...value] = arg.split("=");
      const takes = spec.long?.includes(name) === true;
      const given = value.length > 0 ? value.join("=") : takes ? args[++i] : undefined;
      if (name === spec.chdir?.long && given !== undefined) chdir.push(given);
      if (bin === "taskset" && takes) operands = 0;
      continue;
    }
    // `nice -10`: a number, not a cluster of options.
    if (/^-\d+$/.test(arg)) continue;
    const letters = [...arg.slice(1)];
    if (spec.describes && letters.some((c) => spec.describes?.includes(c))) return undefined;
    const at = letters.findIndex((c) => spec.short?.includes(c));
    if (at < 0) continue;
    const given = arg.slice(at + 2) || args[++i];
    if (letters[at] === spec.chdir?.short && given !== undefined) chdir.push(given);
    if (bin === "taskset") operands = 0;
  }
  const rest = args.slice(i + operands);
  return spec.shell && rest.length > 0 ? inShell(rest.join(" ")) : rest;
}
