# Project Constitution (GEMINI.md)

- Output language: Japanese
- Stack: Discord.js + CDP (Node.js)
- Prefer small, safe diffs.
- Never invent API responses; ask when unsure.
- Follow project Rules and existing patterns.
- Use `gh` for GitHub operations.

## Development Rules
- **Scheduling**: All periodic execution tasks (schedulers) must be registered in `workspace/schedules.json`. Hard-coding in the source code is prohibited.
- **Management**: Schedule management (add, remove, list) must be performed via the Discord `/schedule` command.
- **Environment**: In win32 environments (PowerShell), never use '&&' for command concatenation. Execute commands like `git` individually on separate lines.
- **Branching**: Never push directly to the `main` branch. Even for minor fixes, always create a feature branch and integrate via `gh pr create`.
- **Verification**: When merging multiple pull requests, perform incremental verification (e.g., `tsc` checks) after each merge, rather than fixing everything after a bulk merge.
