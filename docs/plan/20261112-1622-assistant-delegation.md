# Assistant delegation and long-lived session

Status: approved
Created: 2026-11-12 16:22
Follows: [Assistant](20261111-2112-assistant.md); replaces its projects, tasks and sessions parts.

## Goal

The Assistant is one long-lived agent on the VM that delegates work to herdr sessions on every
connected machine: it lists, reads, opens and messages them. Beside its chat, Code mode's own agent
panel shows its Environment and Context plus every agent session it can delegate to.

## Decisions (grilled 2026-11-12)

| # | Decision |
|---|----------|
| 1 | No project registry and no task engine (worktrees, queue, review, merge). Delegation is herdr-native: `ovis-task open` starts a session, `ovis-task send` messages one, `sessions`/`peek` watch them. The delegated agent does its own branching and PRs. |
| 2 | The Assistant pane's right panel is Code mode's real AgentPanel, not an iframe: Environment, Context (Changes hidden: the Assistant folder is no git repo), plus a **Sessions** section styled like Background tasks: every agent pane on the PCs this Ovis is connected to, the VM excepted; each row title, `machine · agent`, elapsed, status dot, chevron; working and blocked first, idle/done folded into an "N finished" row; a click opens that pane in Code mode. One header row per machine carries its health dot and problems (Start herdr). |
| 3 | One Assistant session forever: no New chat, no earlier chats, no daily name. **Restart Assistant** in the pane's ⋯ menu ends the agent and starts a fresh one in the same workspace. Lasting facts live in `notes.md`. |
| 4 | Long-life harness on the VM: (a) when the Assistant's context is over 70% and it is idle, the server sends `/compact` with what to keep (after asking it to save lasting facts to `notes.md`); the CLI's own auto-compact stays on as a backstop. (b) Every 60 s: pane gone → reopen and resume the same conversation (`claude --continue`, `codex resume --last`); agent exited to a shell → relaunch with resume; stuck on a prompt → leave it, show it in the panel. (c) systemd units restart herdr and Ovis; a boot or herdr restart resumes the same way. `check:assistant` gains a long-lived check (one session, its age, last compaction, pane alive). |
| 5 | `ovis-task open <machine> <folder> [--agent claude\|codex] [--create] <brief>`: an existing folder under the machine's home (not home itself), or with `--create` a new one the server makes and `git init`s; the agent runs full auto (the bridge's SKIP_PERMISSIONS); the workspace is named from the brief's first words; the brief is its first message; at most 3 Assistant-opened sessions working at once per machine (the existing max running setting, default 3). |
| 6 | `projects.json` and `tasks.json` stay on the VM untouched and unread. Their routes, UI and ovis-task commands go. Max running keeps its stored value, with no UI. The VM's sidebar row stays first as a tinted card; its one workspace is the long-lived Assistant. |

## Touches

- `server/assistant.ts`, `server/assistant-tasks.ts` (removed or reduced), `server/assistant-sessions.ts`
  (one session, resume, restart, compaction watchdog), `server/ovis-task.ts`, `server/ovis-task-cli.ts`,
  `shared/assistant.ts`.
- `src/App.tsx` (the agent panel for the Assistant pane), `src/components/AgentPanel.tsx` (a Sessions
  section, Changes hidden for the Assistant), `src/components/AssistantView.tsx` (panel, frame and
  page removed; setup page stays), `src/lib/assistantMode.ts`.
- `scripts/assistant-check.ts`, docs/guide.md, changelog fragment.
- herdr API: `workspace/create` (cwd, label, agent), `pane/input`, `pane/keys`, `pane/conversation`,
  `pane/read`; agent resume flags.

## Steps

1. Server: one long-lived session with resume and Restart; the 60 s keep-alive; the compaction
   watchdog. Agent instructions rewritten for delegation.
2. Server: `ovis-task open` (folder checks, `--create`, per-machine limit); remove project and task
   routes and commands.
3. Client: Assistant pane gets AgentPanel + Sessions section; iframe, panel page, New chat, earlier
   chats, projects, task board removed.
4. Harness: long-lived check; open/send covered by unit tests with a fake bridge.
5. Docs, changelog, plan statuses.

## Checks

- Unit tests with a fake bridge and isolated state: open (folder rules, `--create`, limit), keep-alive
  (pane gone, agent exited, prompt waiting), compaction trigger (over 70% and idle only), Restart.
- Browser: from the Mac's tailnet address, the Assistant pane shows Environment, Context, Sessions;
  a session row opens its pane.
- `bun run check:assistant <vm> --ssh --browser` all pass; `bun run check fast`.
- Never open, send to or restart anything in the user's real sessions in testing.

## Open questions

- None yet.
