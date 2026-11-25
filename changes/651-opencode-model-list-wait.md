---
section: fixed
---

- **OpenCode's model list is waited for, not guessed at.** OpenCode 2.4.x loads its providers and models a second or more after its server prints its start-up URL, so CodeDen's model probe could read an empty list and leave the picker with only **Default** ("OpenCode listed no models"), hiding your configured models and their reasoning-effort levels. The probe now polls OpenCode's provider and model lists until they settle, within its existing 20-second budget. The utility model's cheap-model lookup waits the same way, so session titles, follow-up suggestions and summaries keep using a cheap model instead of silently falling back to the default one.
