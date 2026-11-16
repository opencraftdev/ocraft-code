### Added
- herdr-app's keys: Mod+Shift+P opens the palette on its commands, Ctrl+Shift+/ (⌘/ on a Mac)
  lists every shortcut, Alt+[ / ] steps tabs, Alt+↑/↓ (⌘[ / ] on a Mac) steps agents, ⌘⌥[ / ]
  steps workspaces on a Mac, Alt+1–9 (Ctrl+1–9 on a Mac) opens a workspace by number, F2 renames a
  tab and Shift+F2 the workspace; on a Mac ⌘D and ⌘⇧D split the pane. Each can be changed in
  Settings → Shortcuts.
- The command palette matches the letters of a query in order, word starts first, lists the
  commands run last first, offers "Go to workspace: …" and "Go to tab: …" rows, and asks for a
  name in its search field for a command that needs one.
- Other parts of the app can register commands (`src/lib/commands.ts`), found by the palette and
  run by their keys.

### Changed
- An alert in the app is a card in its corner ("codex needs you", "claude finished", with its
  workspace and tab) instead of a system notification; a click opens the agent. A question now
  chimes also for the pane in front of you; a finish still does not.
