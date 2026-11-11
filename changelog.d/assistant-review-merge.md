### Added
- Assistant review and merge: a task created with `--review` gets a fresh reviewer agent in its
  worktree when it is Ready. Its findings go back to the task's agent, up to three rounds, then to
  you as a Needs you card; a pass makes the task Ready (reviewed).
- A Ready task of a GitHub project pushes its branch and opens a PR; **Approve** on its card
  (asked once to confirm, on every device) squash-merges it. A local project's task merges into the
  checkout's branch with `--no-ff`; a checkout with uncommitted changes is refused, and a conflict
  is aborted, never forced, and shown with its files. `--auto-merge` merges without the click once
  the review passed. Only the user approves: `ovis-task` has no way to.
- A merged task is Done, which starts the tasks waiting `--after` it, and its worktree and branch
  are removed. **Dismiss** on a cancelled or failed card removes them too, but never while an agent
  is working in that worktree.
