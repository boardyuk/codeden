---
section: security
---

- **Files read through an interpreter ask like a direct read.** A path in a `python -c`, `node -e`, `ruby -e`, `perl -e` or `php -r` one-liner, in a script written out on an interpreter's input, or handed to PowerShell's `System.IO` types gets the verdict reading that file directly gets: CodeDen's own home and credentials ask at every level. Commands that Perl, Ruby and PHP run in backticks, `qx`, `%x` or `shell_exec` are classified too.
- **More ways of running a command are classified.** Delete and copy tools, shells and interpreters a package manager runs by name (`pnpm rimraf`, `yarn run`, `bun run`), and the command run by `wsl`, `conda run`, `mise exec`, `hatch run`, `pipenv run`, `direnv exec`, `dotenv`, `doppler run`, `cross-env`, `fakeroot`, `unshare`, `runuser`, `gosu`, `script -c`, `tmux new`, `screen`, `parallel`, `at` and `batch`. A new crontab asks at Auto and Full.
