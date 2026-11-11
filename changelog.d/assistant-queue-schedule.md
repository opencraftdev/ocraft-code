### Added
- Assistant queue and schedule: `ovis-task create` now queues a task instead of refusing it when its
  machine is down. A queued task starts once its machine is connected and runs fewer tasks than its
  **Max running tasks**, oldest first; a machine that comes back resumes its queue by itself.
  `--after <id>` waits for that task to be Done (and fails when it fails or is cancelled),
  `--at <time>` (`HH:MM` or an ISO date and time) holds it Scheduled until then, and
  `--cron "<expr>"` (five fields, the VM's local time) makes a template that queues a new task at
  each fire time. A restart neither fires a slot twice nor once per missed slot.
- The task board says what a Queued or Scheduled task waits for (its machine, a free slot, another
  task, a time, or its cron line and next fire time), and those cards have **Cancel**.
