---
section: fixed
---

- **OpenCode uses the project's own config.** A provider defined in a project's `opencode.json`, `opencode.jsonc` or `.opencode/opencode.json` that git doesn't track (such as a custom router) now shows up in the model picker for that project, in New session, the session composer and the project's default model, and its sessions can run it instead of failing with "Model unavailable". CodeDen lists OpenCode's models per project and gives each session the project's config from its main checkout. Your inline config and CodeDen's own settings stay on top, so CodeDen's permission rules, its plugin and its MCP server always win, and a project config never brings in plugins or permission rules. A config file that isn't valid JSON is left out with a warning in the model picker and in the session. Only the config file is read from `.opencode/`: its agents, commands and plugins are not.
