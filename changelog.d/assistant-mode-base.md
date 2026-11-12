### Added
- **⋯ → Assistant VM…** shows how to set up the Assistant VM: its install command and a field for
  its address.
- `scripts/install-assistant.sh` sets up the Assistant VM on a Linux VM: Tailscale, herdr, Bun,
  Claude Code or Codex, and Ovis as systemd user units on `127.0.0.1` behind `tailscale serve`.
  `--dry-run` prints every step without running it.
