# Agent Instructions

Before working on this repository, read `docs/START_HERE.md`.

Use it as the project map. Then open only the docs and source files relevant to the task.

Never print or commit secrets from `.env`, cookies, PSID values, SSO sessions, tokens, database passwords, or API keys.

Active branch: `test`.

For code changes, prefer this flow:

1. Inspect `docs/START_HERE.md` and the relevant linked docs.
2. Make a small, focused change.
3. Run `npm test`.
4. Run `npm run lint`.
5. Commit and push to `origin test` after checks pass.

The production server directory is not a git repository. Deploy from local `HEAD` with the archive-based command documented in `docs/RUNBOOK.md`.

