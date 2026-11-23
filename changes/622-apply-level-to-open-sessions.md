---
section: added
---

- **Apply a project's permissions to its open sessions.** A project's permission level is what its new sessions start with, so its Settings tab lists the open sessions that keep another level (#568). That list now has **Apply to open sessions**, which moves each of them to the project's level, as its own Permissions picker would, from the agent's next tool call (Codex: its next turn). When that raises any session's level, such as Auto to Full, CodeDen asks first and names the sessions it raises; lowering doesn't ask. A session it couldn't change stays listed with the reason. It's a button for you only: no agent, PM or orchestrator tool can do it (#622).
