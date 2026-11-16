// ovis-sessions: the herdr 0.9 sessions on every PC an Ovis server reaches, in herdr-app. herdr-app only
// runs herdr-core terminals; these stay on herdr 0.9 and are reached through Ovis. A row opens the
// session's chat (the ovis-chat mod) or its live terminal (herdr's own `terminal attach`, over ssh for
// another PC, in a tab of a space on this computer). Props: { server } (default http://127.0.0.1:7317).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, checking, run, spaces } from "herdr";
import { sessionGroups, attachArgv, paneTitle, statusOf } from "./sessions.js";

const icon = (name) => `mods/ovis-sessions/icons/${name}.svg`;
const DEFAULT_SERVER = "http://127.0.0.1:7317";

export default class OvisSessions {
  init(_props, cx) {
    const p = props() ?? {};
    this.server = String(p.server || DEFAULT_SERVER).replace(/\/+$/, "");
    this.machines = [];
    this.error = null;
    this.agentsOnly = true;
    this.folded = new Set();
    this.note = null;
    if (checking()) return;
    this.poll(cx);
    cx.timer.every(5000, (cx) => this.poll(cx));
  }

  poll(cx) {
    cx.spawn(async (cx) => {
      try {
        const res = await fetch(`${this.server}/api/machines`);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        this.machines = body?.machines ?? [];
        this.error = null;
      } catch (error) {
        this.error = `Ovis at ${this.server}: ${error?.message ?? error}`;
      }
      cx.notify();
    });
  }

  openChat(machine, pane) {
    run("tab.new", { name: paneTitle(pane), mod: "ovis-chat", props: { server: this.server, machine: machine.id, pane: pane.pane_id } });
  }

  // the terminal runs ssh / herdr on this computer, so its tab goes in a space of this computer
  openTerminal(cx, machine, pane) {
    const argv = attachArgv(machine, pane);
    if (!argv) { this.note = "This session has no terminal to attach to."; cx.notify(); return; }
    const local = spaces().find((s) => s.machine === null);
    const args = { name: `${paneTitle(pane)} · ${machine.name}`, argv };
    if (local) run("tab.new", { ...args, space: local.id });
    else run("space.new", { name: "herdr 0.9", machine: "", tab: args.name, argv });
    this.note = "A pane takes one attached terminal: if Ovis shows this pane's terminal, close it there first.";
    cx.notify();
  }

  button(t, id, name, tip, onClick) {
    return div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick)
      .child(svg(icon(name)).size(14));
  }

  row(t, machine, pane) {
    const st = statusOf(pane);
    const key = `${machine.id}:${pane.pane_id}`;
    return h_flex().id(`row:${key}`).w_full().gap(8).pl(22).pr(4).py(4).rounded(8).items_center().text_size(13)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => pane.agent ? this.openChat(machine, pane) : this.openTerminal(cx, machine, pane))
      .child(svg(icon(pane.agent ? "bot" : "terminal")).size(14).text_color(t.muted))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).child(paneTitle(pane)))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`${pane.pane_id} · ${st.word}`)))
      .when(st.color !== null, (el) => el.child(div().size(7).rounded_full().bg(t[st.color])))
      .when(Boolean(pane.agent), (el) => el.child(this.button(t, `chat:${key}`, "message-square", "Open chat", (_e) => this.openChat(machine, pane))))
      .child(this.button(t, `term:${key}`, "terminal", "Open live terminal", (_e, cx) => this.openTerminal(cx, machine, pane)));
  }

  render() {
    const t = theme();
    const groups = sessionGroups(this.machines, this.agentsOnly);
    const toggle = (key) => (_e, cx) => { this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key); cx.notify(); };
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground).children([
      h_flex().w_full().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border).children([
        div().flex_1().text_size(13).font_semibold().child("herdr 0.9 sessions"),
        div().id("agents-only").px(8).py(2).rounded(6).text_size(12).cursor_pointer()
          .bg(this.agentsOnly ? t.raised : t.background).text_color(this.agentsOnly ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).tooltip(this.agentsOnly ? "Show shells too" : "Agents only")
          .on_click((_e, cx) => { this.agentsOnly = !this.agentsOnly; cx.notify(); })
          .child(this.agentsOnly ? "Agents" : "All"),
      ]),
      v_flex().id("list").flex_1().min_h(0).w_full().px(8).py(6).gap(2).overflow_y_scrollbar().children([
        this.error && div().px(4).py(6).text_size(12).text_color(t.blocked).child(this.error),
        !this.error && groups.length === 0 && div().px(4).py(6).text_size(12).text_color(t.dim).child("No herdr 0.9 sessions on connected PCs."),
        ...groups.flatMap(({ machine, workspaces }) => {
          const mk = `m:${machine.id}`;
          return [
            h_flex().id(mk).gap(6).px(4).py(4).items_center().text_size(12).text_color(t.muted).cursor_pointer()
              .on_click(toggle(mk))
              .child(svg(icon(this.folded.has(mk) ? "chevron-right" : "chevron-down")).size(12))
              .child(svg(icon("monitor")).size(13)).child(div().flex_1().child(machine.name)),
            ...(this.folded.has(mk) ? [] : workspaces.flatMap((w) => {
              const wk = `w:${machine.id}:${w.id}`;
              return [
                h_flex().id(wk).gap(6).pl(14).pr(4).py(3).items_center().text_size(12).text_color(t.dim).cursor_pointer()
                  .on_click(toggle(wk))
                  .child(svg(icon("folder")).size(13)).child(div().flex_1().truncate().child(w.label))
                  .child(div().child(String(w.panes.length))),
                ...(this.folded.has(wk) ? [] : w.panes.map((p) => this.row(t, machine, p))),
              ];
            })),
          ];
        }),
        this.note && div().px(4).py(6).text_size(11).text_color(t.dim).child(this.note),
      ].filter(Boolean)),
    ]);
  }
}
