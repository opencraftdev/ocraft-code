### Added
- The Assistant: one long-lived coding agent (Claude Code or Codex) on a Linux VM you own, in your
  tailnet, that coordinates the herdr sessions on every PC it connects to. Its tool, `ovis-task`,
  lists the machines and every herdr session on them (`machines`, `sessions`), reads one (`peek`:
  an agent's last turns, or a shell's screen), hands work to an agent at rest in one (`send`, as
  if you typed it; never to a working agent or a shell), and starts a new session with an agent in
  a folder under a machine's home (`open`, full auto, the brief as its first message; `--create`
  makes the folder and a git repository; at most 3 working at once per machine). It reaches the
  VM's Ovis on loopback with a token only its pane is given, and is refused ssh, scp, herdr and
  curl. Lasting facts go to its own `notes.md`.
- The Assistant's session lives on: the VM reopens its pane or restarts its agent, resuming the
  same conversation, within a minute of either going away (and after herdr or the VM restarts),
  and compacts its conversation when it is idle past 70% of its context, after it saves notes.
  An agent waiting on a prompt is left alone.
- In Code mode the Assistant VM is a remote PC listed first, as a card tagged **Assistant** in the
  sidebar's own grays, a shade lighter than the rows with a faint edge. Beside the Assistant's chat the agent panel shows Environment and Context and a
  **Sessions** section: every agent session on your PCs, working and blocked first, the rest
  folded, a click opening it. **Restart Assistant** in the ⋯ menu starts it on a fresh
  conversation. Its empty chat greets with "What should the Assistant do?".
- `bun run check:assistant <vm-address>` checks a running Assistant VM end to end: its machines,
  the long-lived session, its conversation, and with `--ssh` and `--browser` the agent's tool and
  the panel.
