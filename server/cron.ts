/**
 * Standard five-field cron (minute hour day-of-month month day-of-week), in this server's local
 * time: `*`, numbers, lists `1,15`, ranges `1-5` and steps `*\/15` or `0-30/10`; day-of-week is 0-7,
 * where 0 and 7 are both Sunday. When both day fields are restricted, a day matching either one
 * matches, as in Vixie cron. Names (`mon`, `jan`) and `@daily` are not taken.
 */
export interface Cron { minute: boolean[]; hour: boolean[]; day: boolean[]; month: boolean[]; weekday: boolean[]; anyDay: boolean; anyWeekday: boolean }

const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

function field(text: string, min: number, max: number): boolean[] | null {
  const set: boolean[] = Array(max + 1).fill(false);
  for (const item of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) return null;
    const from = match[1] === "*" ? min : Number(match[2]);
    // `5/10` runs from 5 to the field's end, as `5-max/10`
    const to = match[1] === "*" || (match[3] === undefined && match[4] !== undefined) ? max : Number(match[3] ?? match[2]);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (from < min || to > max || from > to || step < 1) return null;
    for (let value = from; value <= to; value += step) set[value] = true;
  }
  return set;
}

/** the parsed expression, or null when it is not five valid fields */
export function parseCron(expression: string): Cron | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((part, index) => field(part, FIELDS[index]![0], FIELDS[index]![1]));
  if (sets.some((set) => set === null)) return null;
  const [minute, hour, day, month, weekday] = sets as boolean[][];
  if (weekday![7]) weekday![0] = true;
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday!, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function dayMatches(cron: Cron, at: Date): boolean {
  const day = cron.day[at.getDate()]!;
  const weekday = cron.weekday[at.getDay()]!;
  if (cron.anyDay || cron.anyWeekday) return day && weekday;
  return day || weekday;
}

/** The first minute strictly after `after` (ms) that the expression matches, or null when none comes within about five years. */
export function nextFire(cron: Cron, after: number): number | null {
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  // ponytail: skips a month, a day or an hour at a time, so even `0 0 29 2 *` is found in a few thousand steps
  for (let steps = 0; steps < 100_000; steps += 1) {
    if (!cron.month[at.getMonth() + 1]) { at.setMonth(at.getMonth() + 1, 1); at.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(cron, at)) { at.setDate(at.getDate() + 1); at.setHours(0, 0, 0, 0); continue; }
    if (!cron.hour[at.getHours()]) { at.setHours(at.getHours() + 1, 0, 0, 0); continue; }
    if (!cron.minute[at.getMinutes()]) { at.setMinutes(at.getMinutes() + 1, 0, 0); continue; }
    return at.getTime();
  }
  return null;
}
