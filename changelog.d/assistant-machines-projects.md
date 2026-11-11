### Added
- Assistant mode on the Assistant VM lists herdr's saved machines and checks each one every 30
  seconds: SSH reaches it, herdr runs there, Claude Code or Codex is installed, and the GitHub CLI
  is signed in when one of its projects lands as a pull request. A failed SSH check backs off as
  machine discovery does. Problems show on the machine's row; **Start herdr** runs only when you
  click it, and nothing else is fixed for you.
- **Add project** registers a folder on a machine. The server checks there that it exists, is the
  top folder of a git repository, and is not `/`, the home folder or a folder that holds it. A
  GitHub remote makes the project land as a pull request, otherwise as a local merge; both, and
  the default agent, can be changed later, and a project can be removed. Each machine has a **Max
  running tasks** setting (3 by default). Projects and settings are kept in
  `<stateDir>/assistant/`, written whole with mode `0600`. Only you add projects: the Assistant
  itself never gets a way to.
