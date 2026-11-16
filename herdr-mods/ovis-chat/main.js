// ovis-chat: an agent pane's conversation the way OCraft Code's Chat draws it (src/components/ChatView.tsx,
// Composer.tsx, PromptCard.tsx), read from an Ovis server. Props: { server, machine, pane, readOnly }.
// - server: the Ovis to read from (default http://127.0.0.1:7317); machine: "local" or a machine id
//   that server proxies (/api/machines/<id>/...); pane: the herdr pane id there.
// - readOnly: watch only. The connection says it observes, and nothing can be sent or answered.
// One copy shows one pane, so it works the same as a tab (tab.new {mod, props}) or in place of a
// pane (pane.view {mod, props: {paneId}}: the host's own `pane` prop is then the herdr-app pane).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { WebSocket } from "websocket";
import { props, theme, settings, checking, run } from "herdr";
import { target, apiUrl, wsUrl, Transcript, chatRows, modelText, applyFrame, promptAnswer } from "./chat.js";
import { composerMessage, composerPayload, composerDelivery, composerStatusWord, composerSendShown, submitNote } from "./lib.js";

/** Rows shown per step: the newest ones first, "Show earlier" adds this many. */
const PAGE = 30;
/** The chat column's width, as OCraft's content column. */
const COLUMN = 780;
const icon = (name) => `mods/ovis-chat/icons/${name}.svg`;

export async function getJson(url) {
  const response = await fetch(url);
  let body = null;
  try { body = await response.json(); } catch { /* an empty or non-JSON answer */ }
  return { status: response.status, body };
}

async function postJson(url, data) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  let body = null;
  try { body = await response.json(); } catch { /* none */ }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `HTTP ${response.status}`), { code: body?.error?.code, status: response.status });
  return body;
}

export default class OvisChat extends View {
  init(_props, cx) {
    this.setup(target(props()));
    if (!this.t.pane) { this.s.error = "No pane: open with props {server, machine, pane}"; return; }
    if (checking()) return;
    this.connect(cx);
  }

  // The chat's state and composer, before it knows its pane: ovis-assistant finds the pane first.
  setup(t, placeholder = "Message the agent…") {
    this.t = t;
    this.s = { status: undefined, agent: null, features: new Set(), pending: [], error: null };
    this.rows = [];
    this.meta = null;
    this.shown = PAGE;
    this.open = new Map(); // a work block's fold the user set, by key
    this.details = new Set(); // tool rows opened to their output
    this.prompt = null;
    this.picked = new Set(); // a multi-select prompt's checks
    this.ws = null;
    this.connected = false;
    this.sending = null;
    this.nextId = 1;
    this.note = null;
    this.follow = true;
    this.stick = true;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: this.t.readOnly ? "Watching only" : placeholder });
    this.input.set_auto_grow(1, 8);
    // Enter sends; Shift+Enter is a newline (the textarea has already put the newline in)
    this.input.on("submit", (event, cx) => { if (!event.shift) this.send(cx, true); });
    this.input.on("change", (_e, cx) => cx.notify());
  }

  /** Reads the pane's transcript and opens its socket. */
  connect(cx) {
    this.transcript = new Transcript(getJson, this.t);
    this.refresh(cx);
    cx.spawn((cx) => this.socketLoop(cx));
    // the menu a blocked agent waits on; no frame says it changed on the screen
    cx.timer.every(3000, (cx) => { if (this.s.status === "blocked") this.readPrompt(cx); });
    cx.timer.every(25000, () => this.write({ type: "ping", id: this.nextId++ }));
  }

  async close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) await ws.close().catch(() => {});
  }

  write(frame) {
    if (!this.ws) return false;
    this.ws.write(JSON.stringify(frame)).catch(() => {});
    return true;
  }

  // One socket, read in a tight loop: the host keeps only 8 unread messages, and an attach streams
  // the pane's output, which this view skips without parsing.
  async socketLoop(cx) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const ws = await WebSocket.connect(wsUrl(this.t));
        this.ws = ws;
        attempt = 0;
        for (;;) {
          const raw = await ws.read();
          if (typeof raw !== "string" || raw.startsWith('{"type":"pty-data"')) continue;
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          this.onFrame(frame, cx);
        }
      } catch (error) {
        this.ws = null;
        if (this.connected || !this.s.error) this.s.error = `Disconnected: ${error?.message ?? error}`;
        this.connected = false;
        if (this.sending) { this.note = submitNote("disconnected", ""); this.sending = null; }
        cx.notify();
      }
      await cx.sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }

  onFrame(frame, cx) {
    if (frame.type === "pong") return;
    if (frame.type === "submit-result") {
      if (this.sending?.id === frame.id) {
        if (frame.ok) { this.input.set_value(""); this.note = null; this.sent(); }
        else this.note = submitNote(frame.code ?? "", frame.message ?? "", this.s.agent);
        this.sending = null;
        cx.notify();
      }
      return;
    }
    const effect = applyFrame(this.s, frame, this.t.pane);
    if (effect === "ready") {
      this.connected = true;
      this.s.error = null;
      if (this.t.readOnly) this.write({ type: "role", mode: "observe" });
      // keep_size: this view has no grid, so the pane keeps the size its terminal gives it
      this.write({ type: "attach", pane_id: this.t.pane, cols: 80, rows: 24, keep_size: true });
      if (this.s.features.has("conversation-watch")) this.write({ type: "conversation-watch", pane_id: this.t.pane, enabled: true });
      this.refresh(cx);
      this.readPrompt(cx);
    } else if (effect === "refresh") this.refresh(cx);
    else if (effect === "prompt") { this.rebuild(); this.readPrompt(cx); }
    cx.notify();
  }

  // A burst of conversation-changed frames is one read, and one more after it if any came meanwhile.
  refresh(cx) {
    if (this.loading) { this.dirty = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.dirty = false;
          await this.transcript.refresh();
          this.rebuild();
          cx.notify();
        } while (this.dirty);
        this.loadError = null;
      } catch (error) {
        this.loadError = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  rebuild() {
    const before = this.rows.length;
    this.meta = this.transcript?.newest?.metadata ?? null;
    this.rows = chatRows(this.transcript?.turns() ?? [], this.s.status);
    if (this.follow && this.rows.length >= before) this.stick = true;
  }

  showEarlier(cx) {
    this.shown += PAGE;
    if (this.shown <= this.rows.length || !this.transcript.hasOlder()) return;
    cx.spawn(async (cx) => {
      try { await this.transcript.loadOlder(); this.rebuild(); } catch (error) { this.loadError = String(error?.message ?? error); }
      cx.notify();
    });
  }

  readPrompt(cx) {
    cx.spawn(async (cx) => {
      try {
        const { status, body } = await getJson(apiUrl(this.t, `pane/prompt?pane_id=${encodeURIComponent(this.t.pane)}`));
        const prompt = status === 200 ? body?.prompt ?? null : null;
        if (prompt?.id !== this.prompt?.id) this.picked = new Set();
        this.prompt = prompt;
      } catch { this.prompt = null; }
      cx.notify();
    });
  }

  answer(cx, index) {
    const prompt = this.prompt;
    if (!prompt || this.t.readOnly) return;
    const custom = this.input.value().trim();
    const body = promptAnswer(this.t.pane, prompt, index, custom);
    cx.spawn(async (cx) => {
      try {
        await postJson(apiUrl(this.t, "pane/prompt/answer"), body);
        if (body.custom_text) this.input.set_value("");
        this.prompt = null;
        this.note = null;
      } catch (error) {
        this.note = error.code === "prompt_changed" ? "The question changed. Look again." : `Not answered: ${error.message}`;
        this.readPrompt(cx);
      }
      cx.notify();
    });
  }

  working() {
    return this.s.status === "working";
  }

  send(cx, fromEnter = false) {
    if (this.t.readOnly) return;
    let value = this.input.value();
    if (fromEnter) {
      // the textarea put Enter's newline in at the caret before telling us: take it back out
      const at = this.input.selected_range().start;
      if (at > 0 && value[at - 1] === "\n") value = value.slice(0, at - 1) + value.slice(at);
      this.input.set_value(value);
    }
    value = this.outgoing(value);
    const text = composerMessage(value);
    if (text.trim().length === 0 || this.sending) return;
    const delivery = composerDelivery(this.s.agent, this.s.status);
    if (delivery === "queue" && !this.s.features.has("pending-input")) { this.note = submitNote("pending_input_unsupported", ""); cx.notify(); return; }
    const id = this.nextId++;
    // agents read bracketed paste: the message goes as one paste and the server adds Enter
    const frame = { type: "submit", id, pane_id: this.t.pane, text, payload: composerPayload(value, true), ...(delivery === "queue" ? { delivery } : {}) };
    if (!this.write(frame)) { this.note = submitNote("not_transmitted", ""); cx.notify(); return; }
    this.sending = { id };
    this.follow = true;
    this.stick = true;
    cx.notify();
  }

  /** What goes out for the box's text: ovis-assistant adds its session tags. */
  outgoing(value) {
    return value;
  }

  /** The server took the message. */
  sent() {}

  stop(cx) {
    if (this.t.readOnly) return;
    // the composer's Stop: a lone ESC, sent in the pane's turn (protocol.ts `input.stop`)
    this.write({ type: "input", pane_id: this.t.pane, text: "\u001b", stop: true });
    cx.notify();
  }

  fork(cx, ref) {
    cx.spawn(async (cx) => {
      try {
        const made = await postJson(apiUrl(this.t, "pane/conversation/fork"), { pane_id: this.t.pane, fork_ref: ref, request_id: `ovis-chat-${Date.now()}-${this.nextId++}` });
        run("tab.new", { name: "Fork", mod: "ovis-chat", props: { server: this.t.server, machine: this.t.machine, pane: made.pane_id } });
      } catch (error) { this.note = `Not forked: ${error.message}`; }
      cx.notify();
    });
  }

  // ---- drawing ----

  iconButton(t, id, name, tip, onClick) {
    return div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.dim).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(svg(icon(name)).size(14));
  }

  userRow(t, row) {
    return v_flex().w_full().items_end().gap(4).children([
      ...row.notices.map((text, i) => div().text_size(12).text_color(t.muted).child(text).id(`${row.key}:n${i}`)),
      row.text && div().max_w("80%").bg(t.raised).rounded(16).px(14).py(9).text_size(15).child(TextView.markdown(`${row.key}:md`, row.text).selectable(true)),
      row.text && h_flex().gap(2).children([
        this.iconButton(t, `${row.key}:copy`, "copy", "Copy message", (_e, cx) => cx.write_to_clipboard(row.text)),
        row.fork && !this.t.readOnly && this.iconButton(t, `${row.key}:fork`, "fork", "Fork from here", (_e, cx) => this.fork(cx, row.fork)),
      ].filter(Boolean)),
    ].filter(Boolean));
  }

  workBlock(t, block) {
    const open = this.open.get(block.key) ?? block.open;
    const mono = settings().font_family;
    const head = h_flex().id(block.key).gap(6).items_center().text_size(13).text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.open.set(block.key, !open); cx.notify(); })
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(13))
      .child(block.live
        ? div().text_color(block.waiting ? t.blocked : t.working).child(block.title).loop("opacity", { from: 0.45, to: 1, period: 1400 })
        : div().child(block.title))
      .when(block.summary.length > 0, (el) => el.child(div().text_color(t.dim).truncate().child(`· ${block.summary}`)))
      .when(block.failed > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${block.failed} failed`)));
    if (!open) return head;
    return v_flex().gap(4).child(head).child(v_flex().pl(19).gap(3).children(block.rows.map((row, i) => {
      const id = `${block.key}:${i}`;
      if (row.kind === "note") return div().text_size(13).text_color(t.muted).child(TextView.markdown(`${id}:md`, row.text));
      const shown = this.details.has(id);
      return v_flex().gap(4).child(
        h_flex().id(id).gap(6).items_center().text_size(13).cursor_pointer()
          .text_color(row.error ? t.blocked : t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { if (shown) this.details.delete(id); else this.details.add(id); cx.notify(); })
          .child(svg(icon(shown ? "chevron-down" : "chevron-right")).size(12))
          .child(div().font_family(mono).truncate().child(row.line))
          .when(row.pending, (el) => el.child(div().text_color(t.working).child("…").loop("opacity", { from: 0.3, to: 1, period: 1000 }))),
      ).when(shown, (el) => el.child(
        div().id(`${id}:out`).ml(18).p(8).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .font_family(mono).text_size(12).text_color(t.muted).max_h(320).overflow_y_scrollbar()
          .child(row.detail ? `${row.detail}${row.cut ? "\n… (cut: the whole output is in the terminal)" : ""}` : "(no output)"),
      ));
    })));
  }

  assistantRow(t, row) {
    return v_flex().w_full().gap(10).text_size(15).children([
      ...row.blocks.map((block) => block.kind === "answer"
        ? TextView.markdown(block.key, block.text).selectable(true)
        : this.workBlock(t, block)),
      row.copy && h_flex().gap(2).child(this.iconButton(t, `${row.key}:copy`, "copy", "Copy as markdown", (_e, cx) => cx.write_to_clipboard(row.copy))),
    ].filter(Boolean));
  }

  promptCard(t) {
    const p = this.prompt;
    const multi = p.multi_select;
    return v_flex().w_full().gap(6).p(12).rounded(12).bg(t.surface).border(1).border_color(t.blocked).text_size(14).children([
      div().text_size(12).text_color(t.blocked).font_semibold().child(p.title || "Needs you"),
      p.question && div().text_size(15).child(p.question),
      p.body && div().max_h(220).overflow_y_scrollbar().id("prompt-body").text_size(13).child(TextView.markdown("prompt-body-md", p.body)),
      ...p.options.map((option, index) => h_flex().id(`opt:${index}`).gap(8).px(10).py(6).rounded(8).items_start()
        .bg(this.picked.has(index) ? t.selected : t.background)
        .when(!this.t.readOnly, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
          if (!multi) return this.answer(cx, index);
          if (this.picked.has(index)) this.picked.delete(index); else this.picked.add(index);
          cx.notify();
        }))
        .child(div().text_color(t.dim).child(multi ? (this.picked.has(index) ? "☑" : "☐") : `${index + 1}.`))
        .child(v_flex().flex_1().child(div().child(option.label))
          .when(Boolean(option.description), (el) => el.child(div().text_size(12).text_color(t.muted).child(option.description))))
        .when(index === p.custom_option_index && !option.description, (el) => el.child(div().text_size(12).text_color(t.dim).child("uses the message box")))),
      multi && !this.t.readOnly && h_flex().justify_end().child(div().id("prompt-submit").px(12).py(5).rounded(8).bg(t.solid).text_color(t.solid_foreground)
        .cursor_pointer().on_click((_e, cx) => this.answer(cx, [...this.picked].sort((a, b) => a - b))).child("Submit")),
    ].filter(Boolean));
  }

  /** Drawn above the composer's box: ovis-assistant's session tags and picker. */
  composerTop(_t) {
    return [];
  }

  composer(t) {
    const text = this.input.value();
    const working = this.working();
    const showSend = composerSendShown({ working, text });
    const canSend = !this.t.readOnly && this.connected && !this.sending && text.trim().length > 0;
    const button = showSend
      ? div().id("send").size(34).rounded_full().flex().items_center().justify_center()
        .bg(canSend ? t.foreground : t.raised).text_color(canSend ? t.background : t.dim)
        .when(canSend, (el) => el.cursor_pointer().on_click((_e, cx) => this.send(cx)))
        .tooltip(this.sending ? "Sending…" : working ? "Send for the next turn" : "Send")
        .child(svg(icon("arrow-up")).size(16))
      : div().id("stop").size(34).rounded_full().flex().items_center().justify_center().bg(t.foreground).text_color(t.background)
        .when(!this.t.readOnly, (el) => el.cursor_pointer().on_click((_e, cx) => this.stop(cx)))
        .tooltip("Stop").child(svg(icon("stop")).size(14));
    const status = this.s.status;
    // as OCraft's composer: only a turn in progress or a question shows a word under the box
    const busy = status === "working" || status === "blocked";
    const color = status === "blocked" ? t.blocked : t.working;
    const model = modelText(this.meta);
    const [modelName, effort] = model ? model.split(" · ") : [];
    return v_flex().w_full().gap(8).children([
      ...this.composerTop(t),
      ...this.s.pending.map((m) => h_flex().gap(6).px(12).text_size(12).text_color(t.muted).id(`pending:${m.id}`)
        .child(div().text_color(t.dim).child(m.state === "held" ? "Held" : "Queued")).child(div().truncate().child(m.text))),
      h_flex().w_full().min_h(56).gap(10).items_end().pl(20).pr(10).py(10).rounded(16).bg(t.surface).border(1).border_color(t.border)
        .child(div().flex_1().min_w(0).py(6).text_size(15).child(Textarea.new(this.input)))
        .child(button),
      h_flex().w_full().gap(10).px(8).items_center().text_size(13).text_color(t.muted).children([
        busy && div().text_color(color).child(`● ${composerStatusWord(status)}`),
        !this.connected && div().text_color(t.dim).child("Reconnecting…"),
        this.t.readOnly && div().text_color(t.dim).child("Watching only"),
        (this.note || this.s.error || this.loadError) && div().flex_1().truncate().text_color(t.blocked).child(this.note || this.s.error || this.loadError),
        div().flex_1(),
        // shown with pane.view: back to the pane's own terminal
        this.t.host && div().id("terminal").px(6).rounded(6).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("pane.view", { pane: this.t.host })).child("Terminal"),
        modelName && h_flex().gap(4).text_size(14).text_color(t.foreground).child(effort ? `${modelName} ·` : modelName)
          .when(Boolean(effort), (el) => el.child(effort[0].toUpperCase() + effort.slice(1))),
      ].filter(Boolean)),
    ].filter(Boolean));
  }

  render() {
    return this.chatBody(theme()).id("root").size_full();
  }

  /** The chat column: messages, then the prompt card and composer. ovis-assistant draws it beside its panel. */
  chatBody(t) {
    const first = Math.max(0, this.rows.length - this.shown);
    const visible = this.rows.slice(first);
    const earlier = first > 0 || this.transcript?.hasOlder();
    const column = (el) => h_flex().w_full().justify_center().px(20).child(div().w_full().max_w(COLUMN).child(el));
    const children = [
      earlier && column(h_flex().justify_center().child(div().id("earlier").px(10).py(4).rounded(8).text_size(13).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.follow = false; this.showEarlier(cx); cx.notify(); }).child("Show earlier messages"))),
      ...visible.map((row) => column(row.kind === "user" ? this.userRow(t, row) : this.assistantRow(t, row)).id(`row:${row.key}`)),
      this.rows.length === 0 && column(div().py(40).text_color(t.dim).text_size(14).child(this.loading || !this.transcript ? (this.s.error ?? "Loading the conversation…") : "No messages yet")),
      div().h(8),
    ].filter(Boolean);
    if (this.stick) { this.scroll.scroll_to_item(children.length - 1); this.stick = false; }
    return v_flex().bg(t.background).text_color(t.foreground).children([
      v_flex().id("chat").flex_1().min_h(0).pt(16).gap(18).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_scroll_wheel((e, cx) => { if (e.delta.y > 0 && this.follow) { this.follow = false; cx.notify(); } })
        .children(children),
      !this.follow && h_flex().w_full().justify_center().child(div().id("latest").flex().items_center().gap(4).px(10).py(4).rounded_full()
        .bg(t.raised).text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.follow = true; this.stick = true; cx.notify(); })
        .child(svg(icon("arrow-down")).size(12)).child("Latest")),
      h_flex().w_full().justify_center().px(20).pt(8).pb(12).child(v_flex().w_full().max_w(COLUMN).gap(8)
        .when(this.prompt !== null, (el) => el.child(this.promptCard(t)))
        .child(this.composer(t))),
    ].filter(Boolean));
  }
}
