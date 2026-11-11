### Added
- Assistant tasks: `ovis-task create <project> --title --brief [--agent claude|codex]` starts a
  coding agent on the project's machine, through its Remote PCs bridge, in a new git worktree on
  the branch `assistant/<id>-<slug>`, full auto, with the brief as its first prompt. herdr's focus
  never moves. `ovis-task list [--status]`, `show <id>` (the end of the agent's pane),
  `answer <id> <choice>` (through the prompt-answer route) and `cancel <id>` (closes the pane, keeps
  the worktree) go with it; `approve` is refused, as only the user approves. Tasks are kept in
  `<stateDir>/assistant/tasks.json`.
- A task's status follows herdr's agent state of its pane: Working, Needs you, Ready, or Failed when
  its pane closes or its agent stops. The board on the right of Assistant mode shows them in
  columns; a task opens its pane in Code mode, a Needs you card answers its agent's question in
  place, and a failed one has **Restart agent**. Web push already tells you when a task's agent
  needs you or has finished.
