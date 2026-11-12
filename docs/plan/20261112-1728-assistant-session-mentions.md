# Assistant session mentions

Status: approved
Created: 2026-11-12 17:28
Follows: [Assistant delegation](20261112-1622-assistant-delegation.md)

## Goal

In the Assistant's chat, typing `@` opens a picker of the herdr agent sessions on every connected
machine. Choosing one tags it in the message, several tags per message work, and the Assistant
receives each tag as an exact session (machine, pane id, folder) it can `ovis-task peek` or
`ovis-task send` without guessing.

## Scope

- In: the `@` picker in the Assistant pane's composer (on another Ovis and on the VM itself), the
  tag text, its expansion on send, a chip row under the composer for the message's tags,
  `ovis-task` accepting a machine by its host as well as its name, the agent's instructions.
- Out: tags in any other pane (its `@` stays files and skills); tagging shells (no agent); a
  rich-text composer.

## Decisions (proposed, for your approval)

| # | Decision |
|---|----------|
| 1 | **Where:** only in the Assistant's own pane (`isAssistantPane`). There `@` lists sessions instead of files (the Assistant folder's files are not what you tag). Every other pane is unchanged. |
| 2 | **Data:** the same list as the Sessions section (`assistantSessions`, src/components/AssistantSessions.tsx): agent panes on this Ovis's connected machines, the Assistant VM and its own pane left out, live from the machine snapshots. A machine that is not connected is shown as a dimmed group header "offline" with no items. |
| 3 | **Picker:** grouped by machine, the existing composer menu (`.composer-menu`, same keys: arrows, Enter/Tab, Esc, mouse). Each item: title; under it `folder · agent`; on the right the state dot (working, blocked, idle, done) as the Sessions section draws it. Typing after `@` filters by title, folder, workspace label or machine name, case-insensitive, words in any order. |
| 4 | **The tag in the box:** the composer is a plain textarea and drafts are text, so a tag is readable text that names its session by itself and survives a reload: `@[macbook-pro wV:p1 · trina-ax · MCP progress]` (machine, pane id, folder's last part, title cut to ~24 chars). Backspace right after a tag removes it whole. |
| 5 | **Chips:** under the composer, a quiet row of chips, one per tag in the text (`macbook-pro · trina-ax · MCP progress`, state dot, ×). × removes that tag from the text. Neutral grays like the sidebar card; no color. |
| 6 | **On send:** each tag whose machine and pane are still listed is expanded to an exact line for the agent: `@session(machine="macbook-pro" host="potenlab-macbookpro" pane="wV:p1" folder="/Users/potenlab/repo/trina-ax" agent="claude" title="MCP progress")`. A tag whose session is gone is sent as typed with `(closed)` after it. Several tags each expand. |
| 7 | **Machine names differ** between this Mac's Ovis and the VM (this Mac's own row is `Muhammads-MacBook-Air-2.local`, the VM calls it `muhammad-macbook`). So `ovis-task` resolves a machine by its VM name, its id, or its SSH host (`potenlab-macbookpro`, `muhammads-macbook-air-2`, with or without the tailnet suffix), and the expanded line carries `host`. Pane ids are herdr's own, the same on both sides. |
| 8 | **Agent instructions:** an `@session(...)` in a message is an exact session: use its `host` (or `machine`) and `pane` with `peek`/`send`; act on the tagged sessions only as the message asks. |

## Touches

- `src/lib/mentions.ts` (a `session` trigger kind), `src/components/Composer.tsx` (sessions in the
  menu, chips row, expansion on send), `src/components/AssistantSessions.tsx` (shared list, filter,
  tag format/parse/expand in a small `src/lib/sessionTags.ts`), `src/App.tsx` / `PaneTerminal.tsx`
  (pass the list to the Assistant pane's composer only), CSS, i18n.
- `server/assistant.ts` (`machineNamed` by host), `server/assistant-sessions.ts` (instructions).
- Demo: a QA script that adds a fictional Assistant VM and two fictional machines to the demo
  fixture at build time (as the card screenshots did), no live session.

## Steps

1. `src/lib/sessionTags.ts`: format, parse, filter, expand; unit tests.
2. Composer: the session trigger and menu in the Assistant pane, Backspace-removes-tag, chips row,
   expansion in the send path; tests.
3. Server: `machineNamed` by host; instructions; tests.
4. Demo QA script and screenshots (picker open, filtered, two tags with chips, dark and light).
5. Changelog fragment, docs/guide.md Assistant section, plan status.

## Checks

- Unit: tag round trip, filtering, expansion (present, gone, several), `@` elsewhere unchanged,
  Backspace, ovis-task resolving `potenlab-macbookpro` / `muhammads-macbook-air-2.tail38376d.ts.net`.
- Browser on the demo build: keys, mouse, Esc, two tags, the text a send produces.
- `bun run check fast`; `check:assistant` against the VM after deploy.

## Open questions

- Decision 4's tag text: OK to show the pane id (`wV:p1`) in the box so a tag stays exact after a
  reload, or would you rather a shorter `@[macbook-pro · trina-ax]` that is matched on send (it can
  be ambiguous when one folder has two sessions)?
  Resolved (approved 2026-11-12): the pane id stays in the tag.
