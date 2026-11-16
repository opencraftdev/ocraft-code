import { useMemo } from "react";

/** How many colors a workspace's face takes turns with (Sidebar.css, `data-space-color`). */
export const SPACE_COLOR_COUNT = 5;
const key = (machineId: string) => `ovis:space-colors:${machineId}`;

/**
 * A color per workspace that stays while it lives: a kept one stays, a new one takes the color
 * fewest workspaces have (the first of those), and a gone one frees its color. As herdr-app's
 * spaces list keeps `space.colors`.
 */
export function assignSpaceColors(ids: readonly string[], stored: Readonly<Record<string, unknown>>): Record<string, number> {
  const live = new Set(ids);
  const kept: Record<string, number> = {};
  for (const [id, color] of Object.entries(stored)) {
    if (live.has(id) && typeof color === "number" && Number.isInteger(color) && color >= 0 && color < SPACE_COLOR_COUNT) kept[id] = color;
  }
  for (const id of ids) {
    if (Object.hasOwn(kept, id)) continue;
    const uses = Array.from({ length: SPACE_COLOR_COUNT }, (_, color) => Object.values(kept).filter((taken) => taken === color).length);
    kept[id] = uses.indexOf(Math.min(...uses));
  }
  return kept;
}

/** This browser's colors for a PC's workspaces; storage that cannot be read or written only costs the memory. */
export function useSpaceColors(machineId: string, ids: readonly string[]): Readonly<Record<string, number>> {
  const joined = ids.join("\n");
  return useMemo(() => {
    let stored: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key(machineId)) ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch { /* unreadable: start over */ }
    const colors = assignSpaceColors(joined === "" ? [] : joined.split("\n"), stored);
    try { localStorage.setItem(key(machineId), JSON.stringify(colors)); } catch { /* private window: colors last this page */ }
    return colors;
  }, [machineId, joined]);
}
