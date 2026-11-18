// ovis-assistant: OCraft Code's Assistant (its chat and agent panel: src/App.tsx, AgentPanel.tsx,
// AssistantSessions.tsx) in herdr-app, read from an Ovis server. Props: { server, machine, pane, readOnly }.
// - server: the Ovis to read from (default http://127.0.0.1:7317).
// - machine + pane: the Assistant's pane; left out, it is found on that Ovis's PCs as the web app finds
//   it (an agent pane in the VM's Assistant folder).
// The chat is ovis-chat's own (copied in at build: ./ovis-chat/), with session tags in its composer;
// the panel on the right reads the same routes the web panel does, polled (a mod reads no SSE).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, checking, run, exec, window as hostWindow } from "herdr";
import OvisChat, { getJson } from "./ovis-chat/main.js";
import { target, apiUrl } from "./ovis-chat/chat.js";
import {
  findAssistant, delegateMachines, sessionsSection, statusOf, paneTitle, mentionAt, mentionChoices, dropMention,
  outgoingText, contextUsed, restartCommand, backgroundTasks, changeTotals, voiceUrl, voiceWindowCommand, openCommand,
} from "./assistant.js";
import { machineNamesOf } from "./lib.js";

const icon = (name) => `mods/ovis-assistant/icons/${name}.svg`;
const PANEL = 300;
const q = (v) => encodeURIComponent(v);

export default class OvisAssistant extends OvisChat {
  init(_props, cx) {
    const p = props() ?? {};
    this.setup(target(p), "Message the Assistant…");
    this.override = p.pane ? { machine: p.machine, pane: p.pane } : {};
    this.machines = [];
    this.found = null;
    this.started = false;
    this.allSessions = false;
    this.chips = []; // session tags picked with @: {tag, machineId, paneId}
    this.names = new Map();
    this.prs = [];
    this.changes = null;
    this.activity = null;
    this.asking = false; // Restart Assistant's confirmation
    this.panelNote = null;
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(5000, (cx) => this.poll(cx));
    cx.timer.every(30000, (cx) => this.readPanel(cx));
  }

  // GET /api/machines: the Assistant's pane, its PC, and the sessions it can delegate to
  poll(cx) {
    cx.spawn(async (cx) => {
      try {
        const { status, body } = await getJson(`${this.t.server}/api/machines`);
        if (status !== 200) throw new Error(body?.error?.message ?? `HTTP ${status}`);
        this.machines = body?.machines ?? [];
        this.found = findAssistant(this.machines, this.override);
        if (this.found && !this.started) {
          this.started = true;
          this.t.machine = this.found.machineId;
          this.t.pane = this.found.paneId;
          this.connect(cx);
          this.readPanel(cx);
        } else if (!this.found) this.s.error = "No Assistant on this Ovis's PCs: set one up in OCraft Code (⋯ › Assistant VM…), or open with props {machine, pane}";
      } catch (error) {
        if (!this.started) this.s.error = `Ovis at ${this.t.server}: ${error?.message ?? error}`;
      }
      cx.notify();
    });
  }

  // the Changes and Background tasks sections, and the VM's names for PCs (its graph.json) for tags
  readPanel(cx) {
    const pane = this.found?.pane;
    if (!pane) return;
    const dir = pane.foreground_cwd ?? pane.cwd ?? "";
    cx.spawn(async (cx) => {
      const read = async (path) => { try { const r = await getJson(apiUrl(this.t, path)); return r.status === 200 ? r.body : null; } catch { return null; } };
      const [prs, changes, activity, graph] = await Promise.all([
        read(`pane/prs?pane_id=${q(pane.pane_id)}`),
        dir ? read(`workspace/diff/files?pane_id=${q(pane.pane_id)}&directory=${q(dir)}&scope=workspace`) : null,
        read(`pane/omo-tasks?pane_id=${q(pane.pane_id)}`),
        this.names.size === 0 && dir ? read(`fs/file?path=${q(`${dir.replace(/\/+$/, "")}/graph.json`)}&pane_id=${q(pane.pane_id)}`) : null,
      ]);
      this.prs = prs?.prs ?? [];
      this.changes = changes;
      this.activity = activity;
      if (graph) this.names = machineNamesOf(graph);
      cx.notify();
    });
  }

  delegates() {
    return delegateMachines(this.machines, this.found?.machineId);
  }

  openLink(url) {
    const [command, args] = openCommand(hostWindow().platform, url);
    exec(command, args).catch(() => {});
  }

  /** Voice in the OCraft Voice window (it has the microphone a mod lacks); the browser when that app is missing. */
  openVoice(url) {
    const command = voiceWindowCommand(hostWindow().platform, url);
    if (!command) return this.openLink(url);
    exec(...command).then((r) => { if (r.code !== 0) this.openLink(url); }, () => this.openLink(url));
  }

  // ---- the composer's session tags ----

  mention() {
    if (this.t.readOnly) return null;
    const text = this.input.value();
    const caret = this.input.selected_range().start;
    const at = mentionAt(text, caret);
    return at ? { ...at, caret, choices: mentionChoices(this.delegates(), at.query) } : null;
  }

  choose(cx, choice, at) {
    this.input.set_value(dropMention(this.input.value(), at.start, at.caret));
    this.input.set_selected_range({ start: at.start, end: at.start });
    if (!this.chips.some((c) => c.tag === choice.tag)) this.chips.push({ tag: choice.tag, machineId: choice.machine.id, paneId: choice.pane.pane_id });
    cx.notify();
  }

  send(cx, fromEnter = false) {
    if (fromEnter) {
      // Enter while the picker is open picks its first session instead of sending
      const value = this.input.value();
      const at = this.input.selected_range().start;
      const newline = at > 0 && value[at - 1] === "\n";
      const caret = newline ? at - 1 : at;
      const clean = newline ? value.slice(0, caret) + value.slice(at) : value;
      const m = mentionAt(clean, caret);
      const choices = m ? mentionChoices(this.delegates(), m.query) : [];
      if (choices.length > 0) {
        this.input.set_value(clean);
        return this.choose(cx, choices[0], { ...m, caret });
      }
    }
    super.send(cx, fromEnter);
  }

  outgoing(value) {
    return outgoingText(value, this.chips, this.delegates(), this.names);
  }

  sent() {
    this.chips = [];
  }

  composerTop(t) {
    const m = this.mention();
    return [
      m && v_flex().id("mentions").w_full().p(4).rounded(10).bg(t.popover).border(1).border_color(t.border).text_size(13).children(
        m.choices.length === 0
          ? [div().px(8).py(6).text_color(t.dim).child("No sessions on connected PCs match")]
          : m.choices.map((c, i) => h_flex().id(`mention:${c.machine.id}:${c.pane.pane_id}`).gap(8).px(8).py(5).rounded(6).items_center()
            .bg(i === 0 ? t.hover : t.popover).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(cx, c, m))
            .child(svg(icon("bot")).size(14).text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(paneTitle(c.pane)))
            .child(div().text_color(t.dim).child(c.tag))),
      ),
      this.chips.length > 0 && h_flex().w_full().gap(6).flex_wrap().children(this.chips.map((c) =>
        h_flex().id(`chip:${c.tag}`).gap(4).pl(8).pr(4).py(2).rounded_full().items_center().bg(t.raised).text_size(12).text_color(t.foreground)
          .child(c.tag)
          .child(div().id(`chip-x:${c.tag}`).p(2).rounded_full().cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Remove").on_click((_e, cx) => { this.chips = this.chips.filter((x) => x !== c); cx.notify(); })
            .child(svg(icon("x")).size(11))))),
    ].filter(Boolean);
  }

  // ---- drawing ----

  header(t) {
    const title = this.found?.pane ? paneTitle(this.found.pane) : "Assistant";
    const tab = (id, name, label, active, onClick) => h_flex().id(id).gap(6).px(10).py(4).rounded(8).items_center().text_size(13)
      .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted)
      .when(!active, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)))
      .when(Boolean(onClick), (el) => el.on_click(onClick))
      .child(svg(icon(name)).size(14)).child(label);
    const voice = this.found ? voiceUrl(this.t.server, this.t.machine, this.t.pane, this.found.machine?.target?.destination) : null;
    return h_flex().w_full().h(44).px(16).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border).children([
      div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(title),
      h_flex().p(2).gap(2).rounded(10).bg(t.chrome).border(1).border_color(t.border).children([
        tab("view-chat", "message-square", "Chat", true, null),
        // the call runs in the web app's voice view, in its own window: a mod has no microphone or audio
        tab("view-voice", "audio-lines", "Voice", false, voice && ((_e) => this.openVoice(voice))).tooltip("Talk to the Assistant"),
      ]),
    ]);
  }

  section(t, title, body, extra = null) {
    return v_flex().w_full().gap(8).py(14).border_b(1).border_color(t.border).children([
      h_flex().items_center().gap(8).child(div().flex_1().text_size(15).text_color(t.foreground).child(title)).when(Boolean(extra), (el) => el.child(extra)),
      ...body,
    ].filter(Boolean));
  }

  row(t, id, name, main, sub, onClick, dot = null) {
    return h_flex().id(id).w_full().gap(10).px(6).py(6).rounded(8).items_center().text_size(14)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(svg(icon(name)).size(16).text_color(t.muted))
      .child(v_flex().flex_1().min_w(0).child(div().truncate().child(main))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(12).text_color(t.dim).child(sub))))
      .when(dot !== null, (el) => el.child(div().size(7).rounded_full().bg(dot)))
      .when(Boolean(onClick), (el) => el.child(svg("mods/ovis-chat/icons/chevron-right.svg").size(14).text_color(t.dim)));
  }

  environment(t) {
    const machine = this.found?.machine;
    const pane = this.found?.pane;
    const workspace = machine?.snapshot?.workspaces?.find((w) => w.workspace_id === pane?.workspace_id)?.label ?? pane?.workspace_id ?? "";
    return this.section(t, "Environment", [
      this.row(t, "env-machine", "monitor", machine?.name ?? this.t.machine, null, null),
      this.row(t, "env-folder", "folder", workspace || (pane?.cwd ?? "…"), null, null),
    ]);
  }

  context(t) {
    const used = contextUsed(this.meta);
    const bar = used === null ? null : h_flex().w(56).h(4).rounded_full().bg(t.raised)
      .child(div().h_full().rounded_full().w(Math.max(2, Math.round(56 * used / 100))).bg(used >= 80 ? t.blocked : t.accent));
    return h_flex().w_full().gap(10).py(14).items_center().border_b(1).border_color(t.border).children([
      div().flex_1().text_size(15).child("Context"),
      div().text_size(13).text_color(t.muted).child(used === null ? "Not reported" : `${used}%`),
      bar,
    ].filter(Boolean));
  }

  changesSection(t) {
    const totals = changeTotals(this.changes);
    if (this.prs.length === 0 && totals.files === 0) return null; // the Assistant's folder is no repository
    const prIcon = (s) => s === "merged" ? "git-merge" : s === "closed" ? "git-pull-request-closed" : s === "draft" ? "git-pull-request-draft" : "git-pull-request";
    return this.section(t, "Changes", [
      ...this.prs.map((pr) => h_flex().id(`pr:${pr.url}`).w_full().gap(10).px(6).py(6).rounded(8).items_center().text_size(14)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(pr.url).on_click(() => this.openLink(pr.url))
        .child(svg(icon(prIcon(pr.state))).size(16).text_color(pr.state === "merged" ? t.ansi5 : pr.state === "open" ? t.done : t.muted))
        .child(v_flex().flex_1().min_w(0).child(div().truncate().child(pr.title))
          .child(h_flex().gap(4).text_size(12).text_color(t.dim).child(`${pr.repo} #${pr.number}`)
            .when(pr.additions + pr.deletions > 0, (el) => el.child(div().text_color(t.done).child(`+${pr.additions}`)).child(div().text_color(t.blocked).child(`−${pr.deletions}`)))))
        .when(Boolean(pr.checks), (el) => el.child(div().text_size(12).text_color(pr.checks.failed > 0 ? t.blocked : pr.checks.pending > 0 ? t.working : t.done).child(`${pr.checks.passed}/${pr.checks.total}`)))),
      totals.files > 0 && h_flex().w_full().gap(10).px(6).py(6).items_center().text_size(14)
        .child(svg(icon("file-diff")).size(16).text_color(t.muted))
        .child(totals.added + totals.removed > 0
          ? h_flex().gap(4).child(div().text_color(t.done).child(`+${totals.added}`)).child(div().text_color(t.blocked).child(`−${totals.removed}`))
          : div().child(`${totals.files} ${totals.files === 1 ? "file" : "files"}`)),
    ]);
  }

  sessions(t) {
    const { groups, shown, finished } = sessionsSection(this.delegates(), this.allSessions);
    const machineDot = (m) => m.state === "connected" ? t.done : m.state === "connecting" ? t.working : t.dim;
    const open = (m, p) => (_e) => run("tab.new", { name: paneTitle(p), mod: "ovis-chat", props: { server: this.t.server, machine: m.id, pane: p.pane_id } });
    return this.section(t, "Sessions", [
      shown.length === 0 && div().px(6).text_size(13).text_color(t.dim).child(groups.length === 0 ? "No agent sessions on your PCs." : "No sessions working."),
      ...shown.map(({ machine, panes }) => v_flex().w_full().gap(2).children([
        h_flex().gap(8).px(6).py(2).items_center().text_size(13).text_color(t.muted)
          .child(div().size(7).rounded_full().bg(machineDot(machine))).child(machine.name),
        ...panes.map((p) => this.row(t, `session:${machine.id}:${p.pane_id}`, "bot", paneTitle(p), `${machine.name} · ${p.display_agent ?? p.agent}`,
          open(machine, p), t[statusOf(p).color])),
      ])),
      finished > 0 && this.row(t, "finished", "bot", this.allSessions ? "Hide finished" : `${finished} finished`, null,
        (_e, cx) => { this.allSessions = !this.allSessions; cx.notify(); }),
    ]);
  }

  tasks(t) {
    const { running, ended, runs } = backgroundTasks(this.activity);
    if (running.length === 0 && runs === 0) return null; // shown only while work runs, as the web panel
    return this.section(t, "Background tasks", [
      ...running.slice(0, 3).map((task) => this.row(t, `task:${task.id}`, "layers", task.title, task.model ?? task.category ?? "Running", null, t.working)),
      running.length === 0 && div().px(6).text_size(13).text_color(t.dim).child(`${runs} running`),
      ended.length > 0 && div().px(6).text_size(13).text_color(t.dim).child(`${ended.length} finished`),
    ]);
  }

  restart(t) {
    const pane = this.found?.pane;
    const command = restartCommand(pane?.agent);
    if (!pane || !command || this.t.readOnly) return null;
    const working = (this.s.status ?? pane.agent_status) === "working";
    const button = (id, label, solid, onClick) => div().id(id).px(10).py(5).rounded(8).text_size(13).cursor_pointer()
      .bg(solid ? t.solid : t.raised).text_color(solid ? t.solid_foreground : t.foreground).hover((s) => s.bg(solid ? t.solid : t.hover))
      .on_click(onClick).child(label);
    if (this.asking) {
      return v_flex().w_full().gap(8).py(14).text_size(13).children([
        div().font_semibold().child("Restart Assistant?"),
        div().text_color(t.muted).child(`The Assistant starts a fresh conversation: it sends ${command} to its agent. What it saved in notes.md stays.`),
        h_flex().gap(8).justify_end().children([
          button("restart-cancel", "Cancel", false, (_e, cx) => { this.asking = false; cx.notify(); }),
          button("restart-confirm", "Restart", true, (_e, cx) => {
            this.asking = false;
            const sent = this.write({ type: "submit", id: this.nextId++, pane_id: this.t.pane, text: command, payload: command });
            this.panelNote = sent ? `Sent ${command}` : "Not connected to this PC. Nothing was sent.";
            cx.notify();
          }),
        ]),
      ]);
    }
    return v_flex().w_full().gap(4).py(10).children([
      h_flex().id("restart").w_full().gap(10).px(6).py(6).rounded(8).items_center().text_size(14)
        .text_color(working ? t.dim : t.foreground)
        .tooltip(working ? "Wait until the Assistant is idle" : `Starts a fresh conversation with ${command}`)
        .when(!working, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.asking = true; cx.notify(); }))
        .child(svg(icon("rotate-ccw")).size(16).text_color(t.muted)).child("Restart Assistant"),
      this.panelNote && div().px(6).text_size(12).text_color(t.dim).child(this.panelNote),
    ].filter(Boolean));
  }

  panel(t) {
    return v_flex().id("panel").w(PANEL).flex_none().h_full().px(18).bg(t.background).border_l(1).border_color(t.border)
      .overflow_y_scrollbar().text_color(t.foreground).children([
        this.environment(t),
        this.context(t),
        this.changesSection(t),
        this.sessions(t),
        this.tasks(t),
        this.restart(t),
      ].filter(Boolean));
  }

  render() {
    const t = theme();
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground).children([
      this.header(t),
      h_flex().w_full().flex_1().min_h(0).children([
        div().flex_1().min_w(0).h_full().child(this.chatBody(t).size_full()),
        this.panel(t),
      ]),
    ]);
  }
}
