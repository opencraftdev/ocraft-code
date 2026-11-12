### Added
- The Assistant coordinates every herdr session on the connected PCs: `ovis-task sessions` lists
  each workspace and pane with its agent, state and folder, `ovis-task peek` reads an agent's last
  turns (or a shell's screen), and `ovis-task send` hands work to an agent at rest in a session, as
  if you typed it. It never sends to a working agent, a shell, or a task's own pane.

### Changed
- The Assistant's right panel looks like the agent panel (flat titled sections and rows): Assistant
  with New chat, Tasks, Earlier chats (the newest five, then Show all), Projects and Machines.
- The Assistant VM's PC comes first in Code mode's sidebar, as a tinted card with its own mark.
