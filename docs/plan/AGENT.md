# Feature plans

Plans for new features in this fork live in this folder, one file per feature. Read this file
before writing or following one.

## File name

`<timestamp>-<feature-to-create>.md`

- `timestamp`: when the plan was made, `YYYYMMDD-HHMM` in local time, so files sort by age.
- `feature-to-create`: short kebab-case name of the feature.

Example: `20261111-2045-pane-search.md`.

## Who writes what

- The user writes or approves every plan. An agent may draft one only when asked, and the user
  reads it before any code changes.
- An agent that implements a plan follows it. When the code shows the plan is wrong or
  incomplete, stop and say so instead of quietly changing course.
- Never delete a plan. When a feature ships or is dropped, set its `Status`.

## Plan template

```markdown
# <Feature name>

Status: draft | approved | in progress | done | dropped
Created: <YYYY-MM-DD HH:MM>

## Goal
What the user can do after this ships, in one or two sentences.

## Scope
- In: ...
- Out: ...

## Touches
Files and areas expected to change (`src/`, `server/`, `shared/`), and any herdr API used.

## Steps
1. ...

## Checks
How to know it works: tests to add, `bun run check fast`, manual QA in the demo or a test
session (never the user's live herdr session).

## Open questions
- ...
```

## Rules that still apply

Every plan obeys [AGENTS.md](../../AGENTS.md), [server/AGENTS.md](../../server/AGENTS.md) and
[src/AGENTS.md](../../src/AGENTS.md): the bridge traps, tests and QA rules, and a
`changelog.d/` fragment for user-facing changes.
