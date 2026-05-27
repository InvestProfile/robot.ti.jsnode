# Knowledge Base Guidelines

This repository keeps project memory in `docs/*.md`.

The goal is not to document every line of code. The goal is to let a future human or AI thread find the right files quickly without loading the whole project into context.

## Obsidian Compatibility

The docs use normal Markdown plus Obsidian-style wiki links:

- `[[START_HERE]]`
- `[[ARCHITECTURE]]`
- `[[TRADING_ENGINE]]`
- `[[ORDER_SAFETY]]`
- `[[RUNBOOK]]`
- `[[CURRENT_STATE]]`

To use this as an Obsidian vault:

1. Open the repository folder as a vault, or open only the `docs/` folder.
2. Use `docs/START_HERE.md` as the home note.
3. Obsidian graph view will connect the notes through wiki links.

No `.obsidian` folder is required. If one is added later, keep it local unless there is a clear reason to share workspace settings.

## How To Update

When a meaningful implementation decision is made, update one of:

- `CURRENT_STATE.md` for current open issues and recent changes.
- `TRADING_ENGINE.md` for buy/sell logic.
- `ORDER_SAFETY.md` for order placement, reconciliation, P/L, protective stops.
- `RUNBOOK.md` for commands.
- `ARCHITECTURE.md` for project map changes.

Keep entries short. Link to files rather than pasting code.

## New AI Thread Rule

A new thread should start with:

```text
Read docs/START_HERE.md first. Then read only the docs and source files relevant to the task.
Do not print secrets. Do not load the whole repository unless the task truly requires it.
```

## What Not To Store

Do not store:

- T-Invest tokens.
- Database passwords.
- Cookie values, PSID, SSO sessions, or navi tokens.
- Basic Auth passwords.
- Full broker account sensitive exports.

