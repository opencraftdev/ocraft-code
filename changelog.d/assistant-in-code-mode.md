### Added
- The Assistant lives in Code mode. The Assistant VM is a remote PC tagged **Assistant**, its chat
  is an ordinary pane, and beside that chat the right panel shows the Assistant's controls in place
  of Environment, Context and Changes: New chat (which opens the new chat), the tasks grouped by
  status, the earlier chats, the projects and the machines. Its empty chat greets with "What
  should the Assistant do?".
- On another Ovis that panel is the VM's own, in a frame: the Assistant VM lets pages served from
  a computer's loopback or from its own tailnet (`https://*.<tailnet>.ts.net`) frame it, never
  another tailnet's; every other Ovis still lets nothing frame it.
- **Set up a VM** offers this Ovis's connected Linux machines first and installs over the SSH
  Remote PCs already uses; **Another computer…** still takes an SSH address.
