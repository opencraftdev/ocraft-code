# Assistant one-click setup

Status: approved
Created: 2026-11-12 09:55
Follows: [Assistant](20261111-2112-assistant.md) (deferred item "setup of the VM from the browser over SSH")

## Goal

From the Assistant setup page on any Ovis, you set up a fresh Linux VM as the Assistant without
opening a terminal: enter the VM's SSH address, click **Set up**, watch the install in the page,
answer the few prompts there, and the VM's address fills itself in.

## Decisions

| # | Decision |
|---|----------|
| 1 | It runs the same `scripts/install-assistant.sh` over SSH. No second install path to drift. |
| 2 | The install runs in a terminal shown in the page (xterm, the app's own terminal component), over `ssh -tt`. Prompts the script cannot answer from the form (sudo password, the Tailscale sign-in link, `claude auth login`) are answered right there; links are clickable. |
| 3 | The form asks for the SSH address (`user@host`, optional port), the Tailscale machine name and the agent CLI. Name and agent go to the script as `ASSISTANT_NAME` / `ASSISTANT_AGENT`, validated on the server with the script's own rules. |
| 4 | SSH reuses what Remote PCs uses: the server account's OpenSSH config and agent, Ovis's own `known_hosts`, the setup dialog's fingerprint check (a new host's fingerprint is shown and must be accepted; a changed one fails closed), password and passphrase prompts. Secret entry needs HTTPS or localhost, as today. |
| 5 | The PTY for `ssh -tt` comes from the Rust PTY host or the Node sidecar, never node-pty inside Bun. With neither, the page says it cannot run here and shows the command to paste instead. |
| 6 | The command run on the VM is fixed by the server: fetch the script from the checked-in raw URL (pinned to the commit the server runs, so a cached `main` can never serve an older script), run it with the validated env. Nothing the browser sends becomes shell text except the validated name and agent, quoted. |
| 7 | When the output prints the `https://<name>.<tailnet>.ts.net` address, it fills the **Assistant VM address** field and the page offers **Open**. |
| 8 | Only an authenticated owner of this Ovis can start it (the same check as Add PC). One setup at a time per Ovis. Closing the dialog asks first, and stops the SSH session. |
| 9 | It is offered only on an Ovis that is not the Assistant VM (the setup page). |

## Steps

1. `scripts/install-assistant.sh`: confirm it runs unattended-friendly over `ssh -tt` with
   `ASSISTANT_NAME` / `ASSISTANT_AGENT` set (skip those questions when set and valid), keeps its
   `TS_AUTHKEY` path, and prints the final address on a line the server can match.
2. Server: a route to start a setup (address, port, name, agent), reusing the Remote PCs SSH
   preflight (host key, auth prompts), then a PTY running `ssh -tt <host> '<fixed command>'`,
   streamed to the page over the app's existing terminal transport (WebSocket), with input back.
   Stop and status routes. Origin and auth checks as Add PC.
3. Client: on the setup page, **Set up a VM** opens a dialog: the form, then the host-key and
   secret prompts, then the live terminal; on success the address fills in.
4. i18n, changelog fragment, docs (`docs/guide.md` Assistant section).

## Checks

- Tests with a fake SSH (a local script standing in for `ssh`), isolated test session,
  `mkdtempSync` stateDir, `port: 0`: name/agent validation, the fixed command (pinned ref,
  quoting), owner-only and Origin checks, one setup at a time, stop kills the session, the address
  is picked from output, no PTY host → paste-the-command fallback.
- Manual: a real fresh VM over Tailscale or a public IP, from the Mac's Ovis.
- `bun run check fast`.

## Open questions

- A VM reachable only by password: the first SSH login asks for it in the dialog; the script does
  not install a key. Should setup also add this Ovis's key to the VM? (Default: no.)
