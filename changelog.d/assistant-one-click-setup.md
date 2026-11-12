### Added
- **Set up a VM** on the Assistant setup page: enter a fresh Linux VM's SSH address, its Tailscale
  machine name and the agent CLI, and Ovis runs the Assistant install script there over SSH, with
  the install's terminal in the dialog for its sudo password and sign-in links. The host
  fingerprint and SSH password are asked as Add PC asks them, and the VM's address fills itself in
  when the install prints it. An Ovis without a PTY host shows the command to paste instead.
- `scripts/install-assistant.sh` no longer asks for a machine name or agent CLI already given as a
  valid `ASSISTANT_NAME` or `ASSISTANT_AGENT`.
