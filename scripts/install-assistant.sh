#!/usr/bin/env bash
# The Assistant VM in one line, on a fresh Linux VM (x64 or arm64) you own:
#
#   curl -fsSL https://raw.githubusercontent.com/opencraftdev/ocraft-code/main/scripts/install-assistant.sh | bash
#
# It asks three things first: the VM's Tailscale machine name, how to sign in to Tailscale (a link
# it prints, or an auth key you paste), and the Assistant's agent CLI (Claude Code or Codex). Then it
# installs what is missing (Tailscale, herdr, Bun, the agent CLI, Ovis from source as INSTALL.md 3B
# does), signs the agent in, writes systemd user units for the herdr server and for Ovis on
# 127.0.0.1 with OVIS_ASSISTANT=1, puts `tailscale serve` in front, and prints the HTTPS address.
#
#   --dry-run   print every command instead of running it; nothing is installed or written
#
# Run it again at any time: what is installed stays, the checkout is fast-forwarded, the units are
# rewritten and restarted. Without a terminal (CI), the answers come from the environment or their
# defaults: ASSISTANT_NAME, TS_AUTHKEY, ASSISTANT_AGENT.
#   OVIS_REPO=<owner/name>  OVIS_REF=<branch or tag>  OVIS_PORT=<port>   what to install and where it listens
set -euo pipefail

REPO="${OVIS_REPO:-opencraftdev/ocraft-code}"
REF="${OVIS_REF:-main}"
PORT="${OVIS_PORT:-7317}"
BIN_DIR="$HOME/.local/bin"
CHECKOUT="$HOME/.local/share/ovis-assistant/ovis"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DRY=0

say() { printf '%s\n' "Assistant: $*"; }
fail() { printf '%s\n' "Assistant: $*" >&2; exit 1; }
# every command that changes something goes through run: under --dry-run it is only printed
run() {
  if [ "$DRY" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi
}
# a sign-in that asks at the terminal: under `curl | bash` stdin is the script
run_tty() {
  if [ "$DRY" = 0 ] && has_tty; then "$@" </dev/tty; else run "$@"; fi
}
# writes $2 to the file $1, or prints it under --dry-run
write_file() {
  if [ "$DRY" = 1 ]; then printf '+ write %s:\n%s\n' "$1" "$2"; return; fi
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >"$1"
}
# under `curl | bash` stdin is the script, so questions go to the terminal itself; no terminal, the default
has_tty() { (exec </dev/tty) 2>/dev/null; }
ask() {
  local answer=""
  if has_tty; then read -r -p "$1 [$2]: " answer </dev/tty || true; fi
  printf '%s' "${answer:-$2}"
}

main() {
  case "${1:-}" in
    --dry-run) DRY=1 ;;
    "") ;;
    *) fail "unknown option $1 (only --dry-run)" ;;
  esac
  if [ "$(uname -s)" != Linux ]; then
    [ "$DRY" = 1 ] || fail "runs on Linux; this is $(uname -s)"
    say "not Linux: a dry run shows the commands anyway"
  fi
  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) [ "$DRY" = 1 ] || fail "runs on x64 and arm64; this is $(uname -m)" ;;
  esac
  command -v curl >/dev/null 2>&1 || [ "$DRY" = 1 ] || fail "needs curl"
  command -v git >/dev/null 2>&1 || [ "$DRY" = 1 ] || fail "needs git"

  # 1. the questions, all before anything runs
  local name key="${TS_AUTHKEY:-}" agent
  name=$(ask "Tailscale machine name" "${ASSISTANT_NAME:-ovis-assistant}")
  [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail "a machine name is lowercase letters, digits and inner hyphens: $name"
  if [ -z "$key" ] && has_tty; then
    # a secret: not echoed, and never printed (a dry run shows <auth key>)
    read -r -s -p "Tailscale auth key (Enter to sign in with a link instead): " key </dev/tty || true
    echo
  fi
  agent=$(ask "Assistant agent CLI, claude or codex" "${ASSISTANT_AGENT:-claude}")
  case "$agent" in claude | codex) ;; *) fail "the agent CLI is claude or codex, not $agent" ;; esac

  # ~/.bun/bin first, as scripts/bun-path.sh orders it for the units: an older bun in ~/.local/bin
  # (an npm or manual install) must not win over the Bun this script installs
  export PATH="$HOME/.bun/bin:$BIN_DIR:$PATH"

  # 2. Tailscale, named and signed in
  if ! command -v tailscale >/dev/null 2>&1; then
    say "installing Tailscale"
    run sh -c 'curl -fsSL https://tailscale.com/install.sh | sh'
  fi
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
    # signed in already (a re-run): only the name may change
    run sudo tailscale set --hostname="$name"
  elif [ -n "$key" ]; then
    say "signing in to Tailscale with the auth key"
    if [ "$DRY" = 1 ]; then printf '+ sudo tailscale up --hostname=%s --auth-key=<auth key>\n' "$name"
    else sudo tailscale up --hostname="$name" --auth-key="$key"; fi
  else
    say "signing in to Tailscale: open the link it prints"
    run sudo tailscale up --hostname="$name"
  fi
  # `tailscale serve` as this user, so a re-run needs no sudo for it
  run sudo tailscale set --operator="$(id -un)"

  # 3. herdr and Bun, from their own installers as install.sh does
  if ! command -v herdr >/dev/null 2>&1; then
    say "installing herdr (https://herdr.dev) into $BIN_DIR"
    run sh -c 'curl -fsSL https://herdr.dev/install.sh | sh'
  fi
  # the checkout's bun.lock needs Bun 1.4 (package.json packageManager), as install.sh checks: an
  # older Bun (a distro's or npm's) is replaced by Bun's own install into ~/.bun, first on PATH here
  bun_version=$(bun --version 2>/dev/null || echo 0)
  if [ "$(printf '%s\n' 1.4.0 "$bun_version" | sort -V | head -n1)" != 1.4.0 ]; then
    say "installing Bun (https://bun.sh) into ~/.bun (found: $bun_version, needs 1.4 or newer)"
    # Bun's installer unpacks a zip; a minimal server image (Ubuntu cloud) has no unzip
    if ! command -v unzip >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then run sudo apt-get install -y unzip
      elif command -v dnf >/dev/null 2>&1; then run sudo dnf install -y unzip
      elif [ "$DRY" != 1 ]; then fail "Bun's installer needs unzip; install it and run this again"; fi
    fi
    run bash -c 'curl -fsSL https://bun.sh/install | bash'
    hash -r
    [ "$DRY" = 1 ] || [ "$(printf '%s\n' 1.4.0 "$(bun --version)" | sort -V | head -n1)" = 1.4.0 ] \
      || { say "Bun $(bun --version) at $(command -v bun) is older than 1.4; remove it or put ~/.bun/bin first on PATH, then run this again"; exit 1; }
  fi

  # 4. the agent CLI, signed in (the commands Settings → Usage signs in with, server/usage-login.ts)
  if [ "$agent" = claude ]; then
    command -v claude >/dev/null 2>&1 || run bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
    if [ "$DRY" = 1 ] || ! claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then run_tty claude auth login; fi
  else
    command -v codex >/dev/null 2>&1 || run bun add -g @openai/codex
    if [ "$DRY" = 1 ] || ! codex login status >/dev/null 2>&1; then run_tty codex login --device-auth; fi
  fi

  # 5. Ovis from source (INSTALL.md 3B), fast-forwarded on a re-run
  if [ -d "$CHECKOUT/.git" ]; then
    run git -C "$CHECKOUT" fetch origin "$REF"
    run git -C "$CHECKOUT" checkout --detach FETCH_HEAD
  else
    run git clone --branch "$REF" "https://github.com/$REPO.git" "$CHECKOUT"
  fi
  run bash -c "cd '$CHECKOUT' && bun install --frozen-lockfile"
  # the Rust PTY host, checked, where the ref is a release; without it terminals use Node or a mirror
  run bash -c "cd '$CHECKOUT' && bun scripts/pty-sidecar.ts install || true"

  # 6. the units: herdr's server, and Ovis on loopback beside it, marked as the Assistant VM
  write_file "$UNIT_DIR/herdr.service" "[Unit]
Description=herdr server for the Ovis Assistant

[Service]
ExecStart=$BIN_DIR/herdr server
Restart=on-failure

[Install]
WantedBy=default.target"
  write_file "$UNIT_DIR/ovis-assistant.service" "[Unit]
Description=Ovis, the Assistant VM
Wants=herdr.service
After=herdr.service

[Service]
WorkingDirectory=$CHECKOUT
ExecStart=/bin/sh $CHECKOUT/scripts/with-bun.sh run start
Environment=HOST=127.0.0.1 PORT=$PORT OVIS_ASSISTANT=1 OVIS_ASSISTANT_AGENT=$agent
Restart=on-failure

[Install]
WantedBy=default.target"
  # user units run without anyone signed in
  run sudo loginctl enable-linger "$(id -un)"
  run systemctl --user daemon-reload
  run systemctl --user enable herdr.service ovis-assistant.service
  run systemctl --user restart herdr.service ovis-assistant.service

  # 7. HTTPS for the tailnet in front of it (only the tailnet: serve, never funnel)
  run tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
  local dns="$name.<your-tailnet>.ts.net"
  if [ "$DRY" = 0 ]; then
    # shellcheck disable=SC2016 # JavaScript, not shell
    dns=$(tailscale status --json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).Self.DNSName.replace(/\.$/, ""))')
  fi
  echo
  say "the Assistant is at https://$dns"
}

# the whole script is read before anything runs: under `curl | bash`, a command that reads stdin
# must not swallow the rest of it
main "$@"
