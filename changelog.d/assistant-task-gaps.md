### Fixed
- An Assistant task's brief of several lines keeps its line breaks: it is pasted into the agent once
  the agent is up, instead of joined into one line on its command line.
- A reviewer that stops without a `REVIEW:` verdict line is asked once more for it; if it still gives
  none, the task moves to Needs you ("Reviewer gave no verdict") instead of staying in Reviewing.
- A task's notification is titled by the task ("Task #12 needs you: …", "Task #12 ready: …") and
  replaces the pane's own notification instead of arriving beside it.
