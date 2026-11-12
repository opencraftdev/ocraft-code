### Added
- The Assistant VM keeps a session graph in `assistant/agent/graph.json`: every agent session open
  on its connected machines (not Windows, not the Assistant itself) with its workspace, state,
  title, folder, repo root, branch, remote, PRs, uncommitted files and the files its agent edited,
  and the sessions grouped into projects by remote. It is rewritten a few seconds after a change,
  read again when an agent comes to rest and every 5 minutes. `ovis-task graph [machine]` prints it.

### Changed
- The Assistant keeps a profile folder, `profiles/assistant/` (SOUL.md, PROFILE.md, projects/,
  daily logs/), instead of one notes.md: it logs each send and outcome, distills lasting facts into
  PROFILE.md and project files, and rereads them at start and after a compaction. It may edit only
  its own profile. An existing notes.md is copied unchanged to the profile's logs (and kept as
  notes.md.migrated), and the Assistant is asked once, while at rest, to distill it.
