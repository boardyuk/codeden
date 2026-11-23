---
section: fixed
---

- **Files you attach to a message now reach the agent, the orchestrator and PMs included.** A PDF, a spreadsheet or any other file that isn't an image used to arrive as its bare name with no file behind it, so the orchestrator said it couldn't see it and other agents found it only when a file of that name happened to sit in their worktree (#611). The composer now sends the file itself (up to 20 MB, like images; a larger one is named in a notice and left out), CodeDen keeps it in the session's own artifacts folder under its own name (made safe for every file system; names in any script, such as `отчёт.pdf` or `報告.docx`, stay as they are), and the agent gets that file's full path, which it may read without asking. CodeDen writes only the bytes it received and never opens a path the browser names.
