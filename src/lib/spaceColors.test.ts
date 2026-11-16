import { describe, expect, it } from "bun:test";
import { assignSpaceColors, SPACE_COLOR_COUNT } from "./spaceColors.ts";

describe("assignSpaceColors", () => {
  it("keeps a workspace's color and gives a new one the least used", () => {
    expect(assignSpaceColors(["w1", "w2", "w3"], { w1: 0, w2: 0 })).toEqual({ w1: 0, w2: 0, w3: 1 });
    expect(assignSpaceColors(["a", "b"], {})).toEqual({ a: 0, b: 1 });
  });

  it("frees a gone workspace's color and drops what is not a color", () => {
    expect(assignSpaceColors(["w2", "w9"], { w1: 0, w2: 1, w3: "red", w9: SPACE_COLOR_COUNT })).toEqual({ w2: 1, w9: 0 });
  });

  it("wraps around once every color is taken", () => {
    const ids = Array.from({ length: SPACE_COLOR_COUNT + 1 }, (_, index) => `w${index}`);
    expect(Object.values(assignSpaceColors(ids, {}))).toEqual([...Array.from({ length: SPACE_COLOR_COUNT }, (_, index) => index), 0]);
  });
});
