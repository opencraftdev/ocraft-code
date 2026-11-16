// The ovis-chat mod's logic without its UI: Ovis's endpoints for one pane, the transcript's pages,
// and the rows the chat draws. Pure and host-free (no gpui-kit, no herdr), so `bun test` runs it.
// The chat rules themselves are the web client's own (lib.js, bundled from src/lib).
import {
  formatWorkDuration, isLiveWorkTurn, isToolNarration, isWaitingWorkTurn, modelLabel, toolVerb,
  turnSegments, visibleWorkParts, workFailed, workStartsOpen, workSummary, contextLeftPercent,
} from "./lib.js";

export const DEFAULT_SERVER = "http://127.0.0.1:7317";

/** What the mod shows: props {server, machine, pane, readOnly}. machine "local" is the server's own PC. */
export function target(props) {
  const p = props ?? {};
  const server = String(p.server || DEFAULT_SERVER).replace(/\/+$/, "");
  // Shown in place of a herdr-app pane (`pane.view`), props also carry that pane's own `pane` and
  // `terminal`: the Ovis pane then comes as `paneId`, and `host` is the herdr-app pane to go back to.
  const host = p.terminal ? p.pane ?? null : null;
  return { server, machine: p.machine || "local", pane: p.paneId || (host ? null : p.pane) || null, readOnly: p.readOnly === true, host };
}

/** An Ovis route for the target's machine: the server's own, or through its machine proxy (shared/machines.ts machinePath). */
export function apiUrl(t, path) {
  return t.machine === "local" ? `${t.server}/api/${path}` : `${t.server}/api/machines/${encodeURIComponent(t.machine)}/${path}`;
}

export function wsUrl(t) {
  return `${t.server.replace(/^http/, "ws")}/ws?machine_id=${encodeURIComponent(t.machine)}`;
}

export function conversationUrl(t, query = {}) {
  // no URLSearchParams in QuickJS
  const q = [["pane_id", t.pane], ...["before", "since", "from"].filter((k) => query[k] != null).map((k) => [k, query[k]])];
  return apiUrl(t, `pane/conversation?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`);
}

/**
 * The pane's transcript as pages: `newest` is the latest page, read again from the start it was first
 * read at (`from`), and `older` every turn before it, oldest first. `getJson(url)` resolves {status, body}.
 * A newest page that moved past that start brings the turns in between with it (`before` + `since`),
 * so no turn is dropped while the user reads; a new history starts over.
 */
export class Transcript {
  constructor(getJson, t) {
    this.getJson = getJson;
    this.t = t;
    this.reset();
  }

  reset() {
    this.older = [];
    this.newest = null;
    this.held = undefined; // the newest page's start, as first read
    this.earliest = undefined; // where the oldest loaded turn sits: null at the conversation's start
  }

  turns() {
    return this.newest ? [...this.older, ...this.newest.turns] : this.older;
  }

  /** More turns before the loaded ones can be read. */
  hasOlder() {
    return typeof this.earliest === "string";
  }

  async page(query) {
    const { status, body } = await this.getJson(conversationUrl(this.t, query));
    if (status === 409) return null; // history_changed: the cursor is gone
    if (status < 200 || status >= 300) throw new Error(body?.error?.message ?? `conversation: HTTP ${status}`);
    return body;
  }

  async refresh() {
    const first = this.newest === null || typeof this.held !== "string";
    let page = await this.page(first ? {} : { from: this.held });
    if (page === null || (this.newest !== null && page.history_id !== this.newest.history_id)) {
      this.reset();
      page = await this.page({});
      if (page === null) throw new Error("conversation changed while reading");
    }
    if (this.newest === null || page.cursor === this.held || typeof page.cursor !== "string") {
      if (this.newest === null) this.earliest = page.cursor ?? null;
      // the page reaches the conversation's start: nothing older is held apart from it
      if (typeof page.cursor !== "string") { this.older = []; this.earliest = null; }
      this.newest = page;
      this.held = page.cursor ?? null;
      return page;
    }
    // the newest page moved on: fetch what lies between the held start and the new one
    const gap = [];
    let before = page.cursor;
    for (let guard = 0; guard < 20 && before !== this.held; guard += 1) {
      const between = await this.page({ before, since: this.held });
      if (between === null) { this.reset(); return this.refresh(); }
      gap.unshift(...between.turns);
      if (typeof between.cursor !== "string" || between.cursor === before) break;
      before = between.cursor;
    }
    this.older = [...this.older, ...gap];
    this.newest = page;
    this.held = page.cursor;
    return page;
  }

  async loadOlder() {
    if (!this.hasOlder()) return false;
    const page = await this.page({ before: this.earliest });
    if (page === null) { this.reset(); await this.refresh(); return false; }
    this.older = [...page.turns, ...this.older];
    this.earliest = page.cursor ?? null;
    return page.turns.length > 0;
  }
}

const textOf = (parts) => parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n\n").trim();

/** A work row's one line, as ChatView's tool rows read it: "Read src/a.ts", the agent's own sentence, or the tool's id. */
export function toolLine(part) {
  const summary = (part.summary ?? "").trim();
  if (isToolNarration(part, summary)) return summary;
  const verb = toolVerb(part, summary);
  if (verb !== null) return `${verb} ${summary}`;
  return summary && summary !== part.name ? `${part.name} ${summary}` : part.name;
}

function workRows(parts) {
  return visibleWorkParts(parts, false).map((part) => part.kind === "tool"
    ? { kind: "tool", line: toolLine(part), error: part.error === true, pending: part.state === "pending", detail: (part.output ?? "").trimEnd(), cut: typeof part.output_ref === "string" }
    : part.kind === "text" ? { kind: "note", text: part.text } : { kind: "note", text: part.kind });
}

function noticeText(part) {
  if (part.kind === "notice") return part.text;
  if (part.kind === "task_result") return part.tasks.map((task) => `${task.title}: ${task.status}`).join("\n");
  if (part.kind === "compact") return "Context compacted";
  if (part.kind === "shell") return `! ${part.command}${part.stdout ? `\n${part.stdout}` : ""}${part.stderr ? `\n${part.stderr}` : ""}`;
  if (part.kind === "image") return "[image]";
  return null;
}

/**
 * The rows the chat draws for `turns`, as ChatView draws them: user messages as bubbles, an assistant
 * turn as its answers in the agent's order with each run of work folded under one "Worked for" head.
 * `status` is the pane's agent status, which makes the last turn's head "Working…" or "Needs you".
 * Each row has a stable `key`; a work block's `key` also names its fold.
 */
export function chatRows(turns, status) {
  const seen = new Map();
  return turns.map((turn, index) => {
    const base = `${turn.role}:${turn.ts ?? "?"}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}:${n}`;
    if (turn.role === "user") {
      const text = textOf(turn.parts);
      const notices = turn.parts.map(noticeText).filter((x) => x !== null);
      return { key, kind: "user", text, notices, ts: turn.ts, fork: turn.fork_ref ?? null };
    }
    const live = isLiveWorkTurn(turn, index === turns.length - 1, status);
    const waiting = isWaitingWorkTurn(live, status);
    const segments = turnSegments(turn.parts);
    const works = segments.filter((s) => s.kind === "work");
    const head = works.filter((s) => visibleWorkParts(s.parts, false).length > 0).at(-1) ?? works.at(-1);
    const answers = [];
    const blocks = segments.map((segment) => {
      if (segment.kind === "answer") {
        const text = segment.parts.map((p) => p.text).join("\n\n");
        answers.push(text);
        return { kind: "answer", key: `${key}:a${segment.start}`, text };
      }
      const isHead = segment === head;
      const duration = isHead ? formatWorkDuration(turn.ts, turn.end_ts ?? null) : null;
      const title = waiting && isHead ? "Needs you" : live && isHead ? "Working…" : duration !== null ? `Worked for ${duration}` : "Worked";
      return {
        kind: "work", key: `${key}:w${segment.start}`, title, live: live && isHead, waiting: waiting && isHead,
        summary: workSummary(segment.parts), failed: workFailed(segment.parts), rows: workRows(segment.parts),
        open: (live && isHead) || (segment === segments.at(-1) && workStartsOpen(false, turn.parts)),
      };
    }).filter((b) => b.kind === "answer" || b.rows.length > 0 || b.live);
    if (live && works.length === 0 && answers.length === 0) blocks.push({ kind: "work", key: `${key}:w-pending`, title: waiting ? "Needs you" : "Working…", live: true, waiting, summary: "", failed: 0, rows: [], open: true });
    return { key, kind: "assistant", blocks, copy: answers.join("\n\n"), ts: turn.ts };
  });
}

/** The composer's model pill: "Opus 5.5 · medium", and how much context is left. */
export function modelText(metadata) {
  if (!metadata?.model) return null;
  const label = modelLabel(metadata.model).text;
  return metadata.reasoning_effort ? `${label} · ${metadata.reasoning_effort}` : label;
}

export function contextText(metadata) {
  const left = metadata?.context ? contextLeftPercent(metadata.context) : null;
  return left === null ? null : `${left}% context left`;
}

/**
 * What a server frame changes in the chat's connection state (`s`: {status, agent, features,
 * pending, error, changed}). Returns the effect the mod acts on: "ready" (send role, attach and
 * conversation-watch), "refresh" (read the transcript again), "prompt" (read the waiting menu),
 * or null.
 */
export function applyFrame(s, frame, pane) {
  switch (frame.type) {
    case "snapshot": {
      s.features = new Set(frame.features ?? []);
      const p = frame.snapshot?.panes?.find((x) => x.pane_id === pane);
      if (p) { s.status = p.agent_status; s.agent = p.agent ?? null; }
      else s.error = "This pane is not on that PC any more";
      return p ? "ready" : null;
    }
    case "session-changed": {
      const p = frame.snapshot?.panes?.find((x) => x.pane_id === pane);
      if (p && p.agent_status !== s.status) { s.status = p.agent_status; s.agent = p.agent ?? s.agent; return "prompt"; }
      return null;
    }
    case "pane-status":
      if (frame.pane_id !== pane) return null;
      s.status = frame.agent_status;
      return "prompt";
    case "conversation-changed":
      return frame.pane_id === pane ? "refresh" : null;
    case "pending-messages":
      if (frame.pane_id === pane) s.pending = frame.messages;
      return null;
    case "pane-exited":
      if (frame.pane_id === pane) s.error = "The pane closed";
      return null;
    case "error":
      if (!frame.pane_id || frame.pane_id === pane) s.error = frame.message ?? frame.code;
      return null;
    default:
      return null;
  }
}

/** The answer a click on option `index` of `prompt` posts to /api/pane/prompt/answer. */
export function promptAnswer(pane, prompt, index, customText) {
  if (prompt.multi_select) return { pane_id: pane, prompt_id: prompt.id, option_indices: index };
  if (index === prompt.custom_option_index && customText) return { pane_id: pane, prompt_id: prompt.id, option_index: index, custom_text: customText };
  return { pane_id: pane, prompt_id: prompt.id, option_index: index };
}
