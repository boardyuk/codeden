---
section: security
---

- **More commands are read before they run.** The risk classifier now judges the commands inside PowerShell script blocks (`if`, `try`/`catch`, `foreach`, `& { … }`) and shell function bodies, reads escapes the way the shell that runs the command does (a POSIX backslash, PowerShell's backtick, cmd's `^`), and looks through `sudo` with its options, `timeout`, `nice`, `nohup`, `stdbuf`, `ionice`, `time`, `command`, `builtin`, `exec`, `busybox`, `eval` and `Invoke-Expression` to the command they run. A write or delete outside the worktree in any of these asks at Auto and Full; an `eval` or `iex` string that is only known when it runs asks at Auto.
- **More write tools are recognised.** `dd of=`, `ln`, `chmod`, `chown`, `sed -i`, `truncate`, `install` and `unzip -d`, git's `clone`, `init` and `worktree add` destinations and its `--output` files, and paths that a `python -c`, `node -e`, `perl -e`, `ruby -e` or `php -r` one-liner writes or deletes ask when they are outside the worktree. Ordinary one-liners and the same tools inside the worktree or a temp folder run as before.
