# herdr-core as a second engine

Status: in progress (phase 1 done)
Created: 2026-11-16 13:39

## Goal

A PC's bridge can run on herdr-core, the engine of herdr's desktop app, instead of herdr 0.9,
chosen per machine. herdr 0.9 stays the default and keeps working unchanged: nothing here stops,
restarts or talks to a herdr 0.9 that runs beside a herdr-core.

## Scope

- In (phase 1): a herdr-core client in the server (`hc connect`, framed protocol, JSON-RPC,
  credit flow control, events), engine selection, the `herdr-app` layout document as Ovis's
  workspace/tab/pane snapshot, live status, terminal attach and typed input, screen reads and key
  presses.
- Out of phase 1: anything that changes the layout (create/close/split/move/rename), agents
  launched by Ovis, plugins, worktrees, the machines list, remote PCs over SSH, Windows. Each is a
  later phase below.

## How herdr-core differs (verified against herdr-core `schema/README.md`, `hc.openrpc.json`, `crates/herdr-core/src/{paths,keys,wire}.rs` and herdr-app `src/{hc,mirror,mirror_sync,model,layout}.rs`)

- One long-lived connection, not one socket per request. `hc connect` speaks it over
  stdin/stdout: the first line is `{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true,"generation":1}}`,
  answered by one JSON line (`HelloResult`: generation, version, methods, features, core), then
  binary frames `[channel u32 LE][kind u8][len u32 LE][payload]` (≤ 16 MiB). Kinds: DATA 0,
  CREDIT 1, CLOSE 2, RESIZE 3 (u16 cols, u16 rows), FOCUS 4, FACTS 5, AUTOMATIC_INPUT 6 (only
  after both `hello.features` and the attach reply say `automatic_input`). Channel 0 is JSON-RPC
  2.0 both ways; calls run side by side.
- Streams start with 256 KiB of credit (`wire.rs WINDOW`; herdr-app grants its event stream 1 MiB
  more); the viewer returns CREDIT for bytes it has written out. A viewer > 4 MiB behind gets a
  repaint instead of the backlog.
- herdr-core has terminals only (`t7`; `machine/t7` on another machine). Layout is not core
  state: herdr-app keeps spaces > tabs > split tree in the core document `herdr-app`
  (`doc.get`/`doc.set` with compare-and-set `version`): `{spaces:[{id,name,folder,tabs:[{id,name,root}]}]}`,
  `root` a node `{id,type:row|column|stack|block,children,content:{terminal},size:{weight}|{px},title}`.
  Focus, the selected tab and zoom are each screen's own (herdr-app `View`), not shared.
- Status is whatever the program reports through OSC 7501 (`idle`, `working`, `done`, `blocked`,
  `error`); hc never infers it from the screen. A terminal that never reported has no status.
  `turn` counts turns; the label `herdr.seen` carries the last turn a person looked at.
- Events (`events.subscribe`, one channel of JSON lines): `created`, `restarted`, `labels`,
  `removed`, `finished`, `lost`, `status`, `turn`, `title`, `keep`, `size`, `foreground`, `doc`
  (name and version only), `heartbeat`, and `missed` (a fresh terminal list: resync). Subscribe
  before reading documents; re-read them after `missed` or a reconnect.
- Attach has no exclusive slot: any number of viewers, the last active one sets the size,
  `observe: true` never types or resizes. There is no `--takeover` at all.
- Key names are lowercase (`enter`, `esc`, `ctrl+c`); keys.rs lowercases what it gets, so herdr
  0.9's `Enter`/`Escape` work as they are.

## Mapping: Ovis's herdr 0.9 calls

Every call goes through `server/herdr/client.ts`. With `OVIS_ENGINE=herdr-core` the wrappers in
the first table dispatch to `server/herdr-core/engine.ts`; `herdrRpc` itself refuses every other
method (`unsupported_engine`), so no call can reach a herdr 0.9 running beside the core.

| herdr 0.9 | herdr-core | Phase |
|---|---|---|
| `ping` | `hello` reply (version, generation); attach is always supported | 1 ✅ |
| `session.snapshot` | `events.subscribe` terminal list + `doc.get herdr-app`, mapped (below) | 1 ✅ |
| `events.subscribe` (`pane.agent_status_changed`, lifecycle, `layout.updated`, `pane.exited`) | one unfiltered `events.subscribe`; `status` → `pane.agent_status_changed` per pane, `doc`/`created`/`removed`/`labels`/`title`/`restarted`/`missed` → `layout.updated`, `finished` → `pane.exited` | 1 ✅ |
| `herdr terminal attach` on a PTY | `terminal.attach {terminal, cols, rows, history: 0}` on a byte channel (no pty, no CLI) | 1 ✅ |
| `pane.get` | snapshot lookup | 1 ✅ |
| `pane.read` | `terminal.read {terminal, lines}`: plain text only (no ANSI read in herdr-core) | 1 ✅ (text) |
| `pane.send_keys` | `terminal.keys` | 1 ✅ |
| `pane.send_text` (raw, no Enter) | a short attach at the terminal's own size: DATA, then CLOSE (`terminal.send` always submits) | 1 ✅ |
| `agent.prompt` | `terminal.send {terminal, text}` (paste + Enter; `force`/`if` cover blocked) | 2 |
| `pane.send_input` | `terminal.send` or attach DATA | 2 |
| `pane.wait_for_output` | `terminal.wait {output}` | 2 |
| `agent.get`, `agent.list` | snapshot agents (terminals with `reported`/`status.app`) | 2 |
| `pane.process_info` | the terminal's `pid` and `foreground {pid,name,argv,cwd}` | 2 |
| `agent.start`, `workspace.create`, `tab.create`, `pane.split` | `terminal.run {argv,cwd,env,labels,keep:true,size}`, then `doc.set` the new node (CAS on `version`, re-read on `conflict`) | 3 |
| `pane.close`, `tab.close`, `workspace.close` | `terminal.kill` + remove the node(s) in `doc.set` | 3 |
| `tab.rename`, `workspace.rename`, `pane.rename`, `tab.move`, `workspace.move`, `pane.move`, `pane.swap`, `layout.set_split_ratio`, `pane.resize`, `pane.zoom` | `doc.set` edits of the tree (`size: {weight}`); zoom and focus are this bridge's own view | 3 |
| `agent.rename` | `terminal.label` (name) | 3 |
| `pane.focus` | none: focus is per screen; keep it in the bridge | 3 |
| `pane.scroll`, `pane.copy_motion`, `pane.selection.read`, `pane.clear` | none; `terminal.read` with `lines` covers history; the rest stay unsupported | 3 |
| `worktree.*` | none in core: git in the bridge, then a space with that folder in the doc | 4 |
| `plugin.*`, `integration.list`, `server.agent_manifests`, `pane.report_*`, `pane.release_agent`, `pane.clear_agent_authority` | none: herdr 0.9 plugins and agent hooks; agents report through OSC 7501 instead | 4 (drop or emulate) |
| machines (`hc machine ls/add`) | `machine.list`, `machine.add`; terminals `machine/t7` arrive on the same stream | 4 |

### Snapshot mapping (`server/herdr-core/snapshot.ts`)

- space → workspace (`id`, `name`, else the folder's base name); tab → tab; each `block` with
  `content.terminal` → pane (`pane_id` = node id, `terminal_id` = terminal address).
- Only live terminals become panes; a tab left empty and a space without tabs are dropped.
  Live terminals no tab places (`hc run --bg`, or no document yet) go to a `Terminals` workspace,
  one tab each.
- Status: the 7501 word, `error` → `blocked` (herdr-app alerts on both alike), none → `unknown`;
  rolled up blocked > done > working > idle. `revision` = `turn`. Terminals that report are agents.
- Rects follow each terminal's own grid (`cols`×`rows`; a row adds widths plus a divider). An
  n-way row/column becomes n-1 binary splits. A `stack` lays out only its active child.
- Focus: the first workspace, its first tab and that tab's first pane, since herdr-core shares none.

## Engine selection

Per PC, by the environment of that PC's bridge: `OVIS_ENGINE=herdr-core` (anything else, or
unset: herdr 0.9). `OVIS_HC_BIN` names `hc` when it is not on the PATH; `HC_SESSION` and
`HC_SOCKET` pick the core as they do for hc itself. A settings toggle per saved machine is phase 4.

## Steps

1. ✅ Phase 1 (this PR): `server/herdr-core/{frames,connection,snapshot,engine}.ts`; dispatch in
   `server/herdr/client.ts`; `CoreAttachSession` beside `PtySession` in
   `server/core/terminal-process.ts`.
2. Phase 2, read and type everything: `agent.prompt` → `terminal.send`, `pane.wait_for_output` →
   `terminal.wait`, `agent.get/list`, `pane.process_info` from `foreground`; ANSI reads from a
   short observe attach (first paint) where a styled screen is needed; `done` vs seen from `turn`
   and the `herdr.seen` label (herdr-app docs/labels.md) instead of the raw word; send FACTS
   (colors, cell size) and FOCUS on attaches; AUTOMATIC_INPUT for xterm's query replies once
   negotiated; `resize_notifications` for observers.
3. Phase 3, change the layout: write the `herdr-app` document with compare-and-set, merging
   unknown fields back (herdr-app keeps `rest`), and read again on `conflict`. New panes via
   `terminal.run` with `keep: true` and herdr-app's env (`TERM`, `COLORTERM`, `TERM_PROGRAM`).
   Keep focus/zoom in the bridge. Agent launch through `terminal.run` of the agent's argv.
4. Phase 4, machines and settings: a per-machine engine choice in the machines list, remote PCs
   (`hc machine` or `ssh box hc connect`), the bridge descriptor and finishes epoch keyed on the
   core's identity instead of herdr's socket, and Windows (named pipe through `hc connect`).

## Checks

- `bun test server/herdr-core`: frame codec over any chunking, hello and generation check,
  concurrent calls, error kinds, early frames, credit and pause, CLOSE reasons, lost connection;
  the document mapping; event-to-frame translation; attach both ways; client dispatch and the
  refusal of unmapped herdr 0.9 calls. All on a fake core (`server/herdr-core/core.fake.ts`).
- `server/herdr-core/hc.contract.test.ts` runs against a real core when `OVIS_TEST_HC_BIN`
  names one: its own HOME, XDG dirs, `HC_SESSION` and `HC_SOCKET` under a `mkdtemp` directory,
  stopped afterwards. Building hc needs Zig 0.16 exactly (ghostty's `requireZig`); with 0.17 the
  build stops, so this run was not done here.
- Smoke (done): the whole server with `OVIS_ENGINE=herdr-core` and a fake `hc` serves
  `/api/session` from the document and attaches a pane over `/ws` (`input-ready`, then the
  core's bytes as `pty-data`).

## Open questions

- Should Ovis write `herdr.seen` when a person looks at a pane, so the desktop app and the
  browser agree on what is seen? (herdr-app does; phase 2.)
- Phase 3 doc writes race the desktop app's own writes; CAS makes them safe, but a bridge edit
  and an app edit at once means one of them re-reads and re-applies. Acceptable?
