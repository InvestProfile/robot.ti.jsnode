# Agent Instructions

Before working on this repository, read `docs/START_HERE.md`.

Use it as the project map. Then open only the docs and source files relevant to the task.

Never print or commit secrets from `.env`, cookies, PSID values, SSO sessions, tokens, database passwords, or API keys.

Active branch: `test`.

## Shared memory-core

Before substantial work, check `http://127.0.0.1:8765/health` with a 10-second
timeout. The health response may take about one second while materialization or
embedding jobs are active; do not report memory-core unavailable based on the
old two-second probe alone.

If it is available, search context for project_id `project:robot-ti-jsnode` through memory-core/curl before proceeding.

After substantial changes, write a short event/decision summary to memory-core.

If the memory database is unavailable, explicitly tell the user and continue from local docs. Do not invent memory.

Do not print secrets and do not write tokens to git.

For code changes, prefer this flow:

1. Inspect `docs/START_HERE.md` and the relevant linked docs.
2. Make a small, focused change.
3. Run `npm test`.
4. Run `npm run lint`.
5. Commit and push to `origin test` after checks pass.

The production server directory is not a git repository. Deploy from local `HEAD` with the archive-based command documented in `docs/RUNBOOK.md`.

