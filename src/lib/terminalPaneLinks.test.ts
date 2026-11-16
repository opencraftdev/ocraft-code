import { describe, expect, it } from "bun:test";
import { Terminal } from "@xterm/xterm";
import { paneAddresses, paneLinkPressed, resolvePaneAddress, terminalPaneLinks, type LinkMachine } from "./terminalPaneLinks.ts";

const machines: LinkMachine[] = [
  { id: "local", name: "This PC", snapshot: { panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p3" }] } },
  { id: "m-vps", name: "vps", snapshot: { panes: [{ pane_id: "w2:p7" }] } },
  { id: "nas", name: "nas", snapshot: null },
];
const written = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

describe("paneAddresses", () => {
  it("reads bare and machine-qualified pane addresses", () => {
    expect(paneAddresses("see w1:p3 and vps/w2:p7.").map(({ text, machine, paneId }) => [text, machine, paneId]))
      .toEqual([["w1:p3", null, "w1:p3"], ["vps/w2:p7", "vps", "w2:p7"]]);
  });

  it("leaves words that only contain one alone", () => {
    expect(paneAddresses("xw1:p3 w1:p3x w1:p3:4 a/b/c.w1:p3 http://h/w1:p3 w1:t2 tw1")).toEqual([]);
  });
});

describe("resolvePaneAddress", () => {
  it("opens a bare address on the terminal's own PC only", () => {
    expect(resolvePaneAddress({ machine: null, paneId: "w1:p3" }, "local", machines)).toEqual({ machineId: "local", paneId: "w1:p3" });
    expect(resolvePaneAddress({ machine: null, paneId: "w2:p7" }, "local", machines)).toBeNull();
    expect(resolvePaneAddress({ machine: null, paneId: "w2:p7" }, "m-vps", machines)).toEqual({ machineId: "m-vps", paneId: "w2:p7" });
  });

  it("finds a named PC by its name or id, in any case, and only a live pane", () => {
    expect(resolvePaneAddress({ machine: "VPS", paneId: "w2:p7" }, "local", machines)).toEqual({ machineId: "m-vps", paneId: "w2:p7" });
    expect(resolvePaneAddress({ machine: "m-vps", paneId: "w2:p7" }, "local", machines)).toEqual({ machineId: "m-vps", paneId: "w2:p7" });
    expect(resolvePaneAddress({ machine: "vps", paneId: "w2:p8" }, "local", machines)).toBeNull();
    expect(resolvePaneAddress({ machine: "nas", paneId: "w2:p7" }, "local", machines)).toBeNull();
  });
});

describe("terminalPaneLinks", () => {
  it("links only the live addresses on a row, and opens one on Ctrl or Cmd click", async () => {
    const term = new Terminal({ cols: 40, rows: 3, allowProposedApi: true });
    await written(term, "w1:p3 w1:p9 vps/w2:p7");
    const opened: string[] = [];
    const links = terminalPaneLinks(term.buffer.active, 1, "local", machines, (machineId, paneId, event) => { if (paneLinkPressed(event)) opened.push(`${machineId} ${paneId}`); });
    expect(links.map((link) => [link.text, link.range.start.x, link.range.end.x])).toEqual([["w1:p3", 1, 5], ["vps/w2:p7", 13, 21]]);
    links[0]!.activate({ button: 0 } as MouseEvent, links[0]!.text);
    links[0]!.activate({ button: 0, ctrlKey: true } as MouseEvent, links[0]!.text);
    links[1]!.activate({ button: 0, metaKey: true } as MouseEvent, links[1]!.text);
    expect(opened).toEqual(["local w1:p3", "m-vps w2:p7"]);
  });
});
