### Added
- In the Assistant's chat, `@` tags herdr agent sessions: a picker grouped by PC (an offline PC is
  a dimmed header), filtered by title, folder, workspace or PC in any word order. A tag reads
  `@[macbook-pro wV:p1 · trina-ax · MCP progress]` in the box, Backspace after it removes it whole,
  and a chip row under the composer lists the message's tags with their state and an ×. On send each
  tag reaches the Assistant as an exact `@session(machine=… host=… pane=… folder=… agent=… title=…)`,
  or as typed with `(closed)` when that session is gone. Every other pane's `@` is unchanged.
- `ovis-task` finds a machine by its SSH host as well as its name or id (`potenlab-macbookpro`, with
  or without the tailnet suffix), so a tag from another Ovis resolves on the VM.
