### Fixed
- The Assistant's chat no longer stops at "Couldn't load the conversation" while a new chat's agent
  starts or the connection drops: it waits quietly for up to a minute, then keeps retrying every
  few seconds with the error shown.
- An archived Assistant chat draws its answers as Markdown, as the live chat does.

### Added
- The Assistant can list the machines and the folders open in their herdr workspaces
  (`ovis-task machines`), so it can say which folder to add as a project.
- `bun run check:assistant <vm-address>` checks a running Assistant VM end to end: machines,
  the current and archived chats, framing, and with `--ssh`, `--browser` or `--new-chat` the
  agent's tool and the page itself.
