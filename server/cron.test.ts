import { describe, expect, it } from "bun:test";

import { nextFire, parseCron, type Cron } from "./cron.ts";

const cron = (expression: string): Cron => {
  const parsed = parseCron(expression);
  if (!parsed) throw new Error(`${expression} did not parse`);
  return parsed;
};
const local = (month: number, day: number, hours: number, minutes: number) => new Date(2026, month - 1, day, hours, minutes).getTime();
const at = (ms: number | null) => ms === null ? null : new Date(ms).toString().slice(0, 21);
const next = (expression: string, from: number) => at(nextFire(cron(expression), from));

describe("cron", () => {
  it("takes *, lists, ranges and steps", () => {
    const parsed = cron("*/15 9-17/4 1,15 * *");
    expect(parsed.minute.flatMap((on, value) => on ? [value] : [])).toEqual([0, 15, 30, 45]);
    expect(parsed.hour.flatMap((on, value) => on ? [value] : [])).toEqual([9, 13, 17]);
    expect(parsed.day.flatMap((on, value) => on ? [value] : [])).toEqual([1, 15]);
    expect(cron("5/20 * * * *").minute.flatMap((on, value) => on ? [value] : [])).toEqual([5, 25, 45]);
  });

  it("refuses what is not five valid fields", () => {
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "mon * * * *", "@daily"]) {
      expect(parseCron(bad)).toBeNull();
    }
  });

  it("finds the next minute after a time, never that time itself", () => {
    // Thursday 12 November 2026, 08:00
    const morning = local(11, 12, 8, 0);
    expect(next("* * * * *", morning)).toBe(at(local(11, 12, 8, 1)));
    expect(next("0 9 * * *", morning)).toBe(at(local(11, 12, 9, 0)));
    expect(next("0 8 * * *", morning)).toBe(at(local(11, 13, 8, 0)));
    expect(next("30 6 1 * *", morning)).toBe(at(local(12, 1, 6, 30)));
    expect(next("0 0 29 2 *", morning)).toBe(at(new Date(2028, 1, 29, 0, 0).getTime()));
    expect(nextFire(cron("0 0 31 2 *"), morning)).toBeNull();
  });

  it("reads weekday 0 and 7 as Sunday, and either day field when both are set", () => {
    const morning = local(11, 12, 8, 0);
    expect(next("0 9 * * 0", morning)).toBe(at(local(11, 15, 9, 0)));
    expect(next("0 9 * * 7", morning)).toBe(at(local(11, 15, 9, 0)));
    expect(next("0 9 * * 1-5", local(11, 13, 10, 0))).toBe(at(local(11, 16, 9, 0)));
    // the 20th, or a Monday, whichever comes first
    expect(next("0 9 20 * 1", morning)).toBe(at(local(11, 16, 9, 0)));
  });
});
