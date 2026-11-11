### Added
- Add a right-side workspace panel with agent tabs, inline subagent activity, and a live graph.
  Read recorded dependencies, review attempts, gates, and planned loops from dagr run files.

### Changed
- Give desktop chat a taller T3 Code-style composer and a quieter model toolbar.
- Move desktop file browsing into the right-hand viewer column, keeping chat usable. Open
  selected files beside the conversation and offer a way back to Browse in the viewer header.
- Keep the original computer/workspace sidebar and Agents roster, with quieter chat header
  and composer spacing.
- Pin the workspace/agent card at the right of desktop chat, with files and previews in a separate right-hand drawer.
- Restyle the right rail as separate, collapsible Environment and Agents sections, following
  the supplied sidebar reference while retaining agent details, graphs, and file viewing.
- Float the right-hand cards over the shared chat canvas, removing the full-height filled rail.
- Scroll workspaces and Agents together in one sidebar, keeping search and Settings fixed.
- Open agent details in a right-hand drawer, retaining the floating summary cards.
- Show reported context usage and token counts in the right rail, with explicit unknown states.
- Separate Changes, Background tasks, and Agents; show the graph only inside agent details.
- Open file browsing and changes in the right-hand drawer, preserving preview history and drafts.
- Expand background jobs into command/output cards with elapsed times, Running and Finished groups,
  and recorded workflow stages in the right drawer.
- Expand Context into a token ratio, usage bar and category table when the agent reports a matching
  breakdown; retain accurate aggregate and unknown states for other sessions.
- Simplify Agents to active/finished entries, and open prompt, model and recorded activity details
  when selecting an agent. Fold tool-call batches and keep the graph as an explicit separate action.
- Read completed subagent details as well as running work, preserving Back navigation and focus.
