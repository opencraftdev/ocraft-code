### Added
- Assistant mode on the Assistant VM has the Assistant's chat in the middle: Code mode's chat view
  of a Claude Code or Codex pane (the one the install script set up) that herdr runs on the VM, in
  `<stateDir>/assistant/agent/`. That folder holds its instructions (`AGENTS.md`, with `CLAUDE.md`
  pointing at it), its own `notes.md` and its permission settings: it may run `ovis-task` and read
  its own folder, and is refused ssh, scp, herdr, curl and edits anywhere else. It is never started
  in full auto.
- **New chat** starts a fresh Assistant session, named by its start time (`YYYYMMDD-HHMM`). The one
  before it is archived: its conversation is saved and its pane closed, and **Sessions** in the
  sidebar shows it read only.
- `ovis-task`, the Assistant's one tool: `projects`, `read <project> <path>`,
  `grep <project> <pattern> [path]` and `git <project> log|diff|status|show`. It reaches the VM's
  Ovis on loopback with a token only the Assistant's pane is given. Every path is resolved on the
  project's machine, `..` and symlinks included, and refused when it leads outside the project
  folder; git options that write a file, run a program or leave the repository are refused, and
  output is capped at 256 KiB.
