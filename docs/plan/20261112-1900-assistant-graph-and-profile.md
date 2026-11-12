# Assistant: clean session tags, a session graph, a profile folder

Status: approved
Created: 2026-11-12 19:00
Follows: [Assistant session mentions](20261112-1728-assistant-session-mentions.md),
[Assistant delegation](20261112-1622-assistant-delegation.md)

## Goal

1. A session tag in the Assistant's message box reads `@muhammad-macbook/ovis`, shows once, and still
   reaches the Assistant as an exact `@session(...)`.
2. The VM keeps a JSON graph of the active herdr sessions (machine, workspace, pane, agent, state,
   title, folder, repo, branch, remote, PRs, files touched), refreshed as sessions change, which the
   Assistant reads to know which files belong to which session and project.
3. The Assistant keeps a profile folder (SOUL.md, PROFILE.md, projects/, logs/) instead of one
   notes.md, writes to it as it works, and reads it at start and after each compaction.

## Scope

- In: the tag text and its look in the Assistant pane's composer; `graph.json` on the VM, its
  refresher and `ovis-task graph`; the profile folder, its seeding, the migration of notes.md, the
  instructions, the agent's edit permissions and the pre-compaction request.
- Out: tags in other panes; graphs of closed sessions or history; a UI for the graph or the
  profile (both are files the Assistant reads; you can open them in Ovis's file viewer); semantic
  search or embeddings.

## Decisions (proposed, for your approval)

### 1. Session tags

| # | Decision |
|---|----------|
| 1.1 | **Text in the box:** `@<machine>/<folder>`, e.g. `@muhammad-macbook/ovis`. When the same machine has two picked-able sessions in that folder, the second gets the pane: `@muhammad-macbook/ovis:wN:p2`. No title, no brackets. |
| 1.2 | **Friendly machine name:** the name the VM gives it (`ovis-task` names). The Mac's Ovis reads it from the graph file of Decision 2 (`graph.json`, through the Assistant VM's existing `fs/file` proxy, once per picker open, cached) by matching SSH host. Before a graph exists, it falls back to the host without `.local`/tailnet suffix, lowercased (`muhammads-macbook-air-2`). |
| 1.3 | **Look:** the textarea stays plain text (drafts stay text). A highlight layer behind it draws each tag as a soft neutral pill (background only, same font and width, so the caret never drifts). This is the "inline chip" without a rich-text editor. |
| 1.4 | **Shown once:** the chip row under the box is removed. Hovering a tag's pill is not possible through a textarea, so the picker item itself is the only place the title shows. |
| 1.5 | **Exact on send:** the composer remembers each picked tag's machine id and pane id while the draft lives; on send each tag expands to the same `@session(machine= host= pane= folder= agent= title=)` as today. A tag without that memory (after a reload) resolves by machine + folder (+ pane when written); none open sends it with `(closed)`, more than one open sends the first and says `(ambiguous: wN:p1, wN:p2)`. |
| 1.6 | Backspace right after a tag still removes it whole. |

### 2. Session graph

| # | Decision |
|---|----------|
| 2.1 | **File:** `~/.config/ovis/assistant/agent/graph.json`, written by the VM's Ovis server only (the agent may read, never edit; denied in its settings). Written atomically. |
| 2.2 | **Active only:** every pane open now on every connected, non-Windows machine with an agent (shells left out), the Assistant's own pane left out. A pane that closes is dropped at the next write; a machine that disconnects keeps its sessions out until it is back. |
| 2.3 | **Shape:** `{ updated_at, machines: [{ name, id, host, state }], projects: [{ repo, remote, roots: { "<machine>": "<path>" }, sessions: ["<machine>/<pane>"] }], sessions: [{ key, machine, host, workspace, pane, agent, state, title, folder, repo_root, branch, head, remote, prs: [{ number, url, title, state }], files: { changed: [...], touched: [...] }, assistant_opened, seen_at }] }`. `projects` groups sessions by remote (or by repo root when there is none), so the Assistant can go file → session → project. |
| 2.4 | **Sources, all already in Ovis:** machine snapshots (workspace, pane, agent, state, title, folder); per pane through the existing machine bridge: `workspace/diff/files` (repo root, branch, head, uncommitted changed files), `pane/prs` (PRs the agent linked, with state; gh on that machine, cached 30 s), `pane/conversation` (files touched: paths in its Read/Edit/Write/apply_patch tool inputs, newest 50); `git remote get-url origin` once per repo root through the existing health script runner. |
| 2.5 | **Refresh:** cheap fields (open/close/state/title) rewrite the file within a few seconds of a snapshot change (debounced 3 s). Repo, PRs and files are re-read for a pane when it opens and when its agent comes to rest (working → idle/done), plus a sweep every 5 min; one machine at a time, a pane whose reads fail keeps its last values. |
| 2.6 | **Read:** `ovis-task graph [machine]` prints it (or one machine's part); the instructions also say the file path. |

### 3. Profile folder

| # | Decision |
|---|----------|
| 3.1 | **Per session:** `agent/profiles/<session>/` where `<session>` is the session's name, `assistant` for today's long-lived one; `session.json` gains `profile: "assistant"`. A future second Assistant session gets `profiles/<its name>/` seeded with the same layout. |
| 3.2 | **Layout:** `SOUL.md` (who it is, how it works: written by the server once, then the agent may refine it), `PROFILE.md` (the user, preferences, machines and what each holds), `projects/<project>.md` (one per project: the folder on each machine, repo/remote, people, open work, history), `logs/YYYY-MM-DD.md` (append-only daily log: what was delegated where, to which pane, and the outcome). |
| 3.3 | **Growing daily:** the instructions say: append to today's log as you work (every send/open and every outcome you see); before a compaction and at the end of a day's first conversation turn after midnight, distill lasting facts from logs into PROFILE.md and projects/; keep PROFILE.md and each project file short, rewrite rather than append. |
| 3.4 | **Reading:** at the start of a conversation and after a compaction: SOUL.md, PROFILE.md, the projects/ file names (open the ones the message touches), today's and yesterday's log, then `ovis-task graph`. The pre-compaction request (NOTES_REQUEST) and the `/compact` keep text name the profile instead of notes.md. |
| 3.5 | **Permissions:** Edit/Write allowed in `./profiles/<session>/**` only; `graph.json`, AGENTS.md, CLAUDE.md, settings stay denied. Codex's sandbox already keeps writes in the folder. |
| 3.6 | **Migration, nothing lost:** on first start with no profile, the server copies notes.md verbatim to `profiles/assistant/logs/<today>-notes-import.md` and renames notes.md to `notes.md.migrated` (kept). Then, once, it asks the running Assistant (only while it is at rest) to distill that import into PROFILE.md and projects/ files. I will also do that distillation by hand now for today's notes and check it line by line against the import, so the split does not depend on the agent. |

## Touches

- `src/lib/sessionTags.ts` (short tag, resolve, remembered picks, friendly names), `src/components/Composer.tsx`
  (highlight layer, chip row removed), CSS, i18n; a small client read of the VM's `graph.json` through
  `/api/machines/<vm>/fs/file`.
- `server/assistant-graph.ts` (new: build, refresh, write), `server/assistant.ts` (wire it, `graph` route),
  `server/ovis-task.ts` / `ovis-task-cli.ts` (`graph`), `server/assistant-sessions.ts` (profile folder,
  instructions, settings, notes request, migration), `shared/assistant.ts` (graph types).
- herdr: no new API; existing bridge routes `workspace/diff/files`, `pane/prs`, `pane/conversation`.

## Steps

1. Server: profile folder, migration, instructions, permissions, compaction text; tests.
2. Server: graph builder and refresher, `ovis-task graph`; tests with a fake bridge.
3. Client: short tags, remembered picks, friendly names from graph.json, highlight layer, chip row out; tests.
4. Demo QA script and screenshots (picker, two tags highlighted in the box, dark and light).
5. Changelog fragment, docs/guide.md, plan status. PR, merge on your word, deploy to the Mac and VM,
   then the hand distillation of notes.md (3.6) on the VM and `check:assistant` (gains: graph.json
   fresh, profile folder present).

## Checks

- Unit: tag format/resolve (unique, two in one folder, reload without memory, closed, ambiguous);
  graph (active only, closed pane dropped, shells and the Assistant left out, project grouping,
  touched-file extraction, failed reads keep last values); profile seeding, migration keeps notes.md
  byte for byte, permissions name only the profile.
- Browser on the demo build: pick two sessions, highlight aligned with the text while typing and
  scrolling, Backspace, the sent text.
- `bun run check fast`; `check:assistant` after deploy; read graph.json on the VM and compare with
  `ovis-task sessions` (read-only, nothing sent to your sessions).

## Open questions

- 1.1: `@muhammad-macbook/ovis` OK, or the title too? Resolved (2026-11-12): `@muhammad-macbook/ovis`.
- 2.4: touched files: edited/written only, or reads too? Resolved: edited/written only (plus uncommitted changes).
- 3.1: the long-lived session's profile name? Resolved: `assistant`.
