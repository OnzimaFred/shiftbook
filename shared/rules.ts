// Shiftbook rules: rotation, roster checks, cover cost and monthly overtime.
// Pure functions with no screen or database code, so the app and the server
// calculate the same numbers. Dates are plain "YYYY-MM-DD" strings in plant time.

export type Code =
  | "D/P" | "N/P" | "N/W" | "D" | "O.T D/P" | "O.T N/P" | "OFF"
  | "A/L" | "S/L" | "C/L" | "ML" | "U/L" | "";

export type Designation =
  | "plant_manager" | "maintenance_supervisor" | "site_admin" | "ehs_officer"
  | "plant_technician_2" | "plant_technician" | "plant_assistant"
  | "sanitation_environment" | "machine_operator";

export type Letter = "A" | "B" | "C" | "R" | "F" | "E" | "G";

export interface Person {
  id: string;
  name: string;
  designation: Designation;
  letter: Letter;
  /** Plant id for a day, or null for shared staff. */
  plantOn: (day: string) => string | null;
}

export interface Rules {
  holidays: Set<string>;
  rotation: { cycle: Code[]; offsets: Record<string, number>; anchor: string };
  shiftWeeklyMinutes: number;   // 48 h
  generalDailyMinutes: number;  // 8 h
  overtimeRate: number;         // 1.5
  holidayRate: number;          // 2
  pt2ExtendMinutes: number;     // 120: PT II stays 17:00-19:00
}

export const DEFAULT_RULES: Omit<Rules, "holidays"> = {
  rotation: { cycle: ["D/P", "D/P", "N/P", "N/P", "OFF", "OFF"], offsets: { A: 0, B: 2, C: 4 }, anchor: "2026-11-04" },
  shiftWeeklyMinutes: 48 * 60,
  generalDailyMinutes: 8 * 60,
  overtimeRate: 1.5,
  holidayRate: 2,
  pt2ExtendMinutes: 120,
};

type CodeInfo = { type: "D" | "N" | "G" | null; leave?: string; overtime?: boolean; loc: string };
export const CODES: Record<Code, CodeInfo> = {
  "D/P": { type: "D", loc: "DP" },
  "N/P": { type: "N", loc: "NP" },
  "N/W": { type: "N", loc: "NW" },
  "D": { type: "G", loc: "DG" },
  "O.T D/P": { type: "D", loc: "DP", overtime: true },
  "O.T N/P": { type: "N", loc: "NP", overtime: true },
  "OFF": { type: null, loc: "OFF" },
  "A/L": { type: null, loc: "AL", leave: "annual" },
  "S/L": { type: null, loc: "SL", leave: "sick" },
  "C/L": { type: null, loc: "CL", leave: "casual" },
  "ML": { type: null, loc: "MP", leave: "maternity_paternity" },
  "U/L": { type: null, loc: "UL", leave: "unpaid" },
  "": { type: null, loc: "NA" },
};

// ---------- Dates ----------
const MS_DAY = 86_400_000;
const toUTC = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const addDays = (d: string, n: number) => new Date(toUTC(d) + n * MS_DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toUTC(b) - toUTC(a)) / MS_DAY);
/** 0 = Sunday ... 6 = Saturday */
export const weekday = (d: string) => new Date(toUTC(d)).getUTCDay();
export const isWeekend = (d: string) => weekday(d) === 0 || weekday(d) === 6;
export function monthDays(month: string): string[] {
  const first = month.slice(0, 7) + "-01";
  const out: string[] = [];
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- Who is what ----------
export const isRotating = (p: Person) => p.letter === "A" || p.letter === "B" || p.letter === "C";
export const isShiftTeam = (p: Person) => isRotating(p) || p.letter === "R";
export const canHead = (p: Person) => p.designation === "plant_technician" || p.designation === "plant_technician_2";
export const isAssistant = (p: Person) => p.designation === "plant_assistant";

/** The code a person gets from the rotation and working pattern, before any hand edits. */
export function rotationCode(p: Person, day: string, r: Rules): Code {
  if (isRotating(p)) {
    const n = daysBetween(r.rotation.anchor, day) - r.rotation.offsets[p.letter];
    return r.rotation.cycle[((n % 6) + 6) % 6];
  }
  if (p.letter === "R") return "OFF";                       // relief: covers only
  if (r.holidays.has(day)) return "OFF";
  if (p.letter === "E") return weekday(day) === 0 ? "OFF" : "D";   // Mon-Sat
  return isWeekend(day) ? "OFF" : "D";                       // F and G: Mon-Fri
}

/** The code to use when this person covers a shift. */
export const coverCode = (p: Person, shift: "D" | "N"): Code =>
  isShiftTeam(p) ? (shift === "D" ? "O.T D/P" : "O.T N/P") : (shift === "D" ? "D/P" : "N/P");

// ---------- Pay ----------
/** Paid minutes for one day's code. */
export function paidMinutes(p: Person, day: string, code: Code, r: Rules): number {
  const t = CODES[code]?.type;
  if (!t) return 0;
  if (t === "G") return r.generalDailyMinutes;
  if (!isShiftTeam(p)) {
    // General-shift staff covering: a weekday day shift just extends their day to 19:00.
    const working = rotationCode(p, day, r) === "D";
    return t === "D" && working ? r.generalDailyMinutes + r.pt2ExtendMinutes : 12 * 60;
  }
  return 12 * 60;
}

/** Minutes that fall on a public holiday. A night starting the evening before a holiday
 *  earns the holiday rate for the 7 hours after midnight. */
export function holidayMinutes(p: Person, day: string, code: Code, r: Rules): number {
  const t = CODES[code]?.type;
  if (!t) return 0;
  let m = 0;
  if (r.holidays.has(day)) m += t === "N" ? 5 * 60 : paidMinutes(p, day, code, r);
  if (t === "N" && r.holidays.has(addDays(day, 1))) m += 7 * 60;
  return m;
}

/** The month's contract: 48 h a week pro rata for the shift team, 8 h per working day otherwise. */
export function contractMinutes(p: Person, month: string, r: Rules): number {
  const days = monthDays(month);
  if (isShiftTeam(p)) return Math.round((r.shiftWeeklyMinutes * days.length) / 7);
  return days.filter((d) => rotationCode(p, d, r) === "D").length * r.generalDailyMinutes;
}

export interface MonthSummary {
  workDays: number; offDays: number; annualLeave: number; matPatLeave: number;
  paidMinutes: number; contractMinutes: number; overtimeMinutes: number; holidayMinutes: number;
  /** Paid-time equivalent: overtime × 1.5 + holiday hours × 2. */
  payableExtraMinutes: number;
}

export function monthSummary(p: Person, month: string, cell: (day: string) => Code, r: Rules, plant?: string): MonthSummary {
  const days = monthDays(month).filter((d) => !plant || p.plantOn(d) === plant);
  let paid = 0, ph = 0, work = 0, off = 0, al = 0, ml = 0;
  for (const d of days) {
    const c = cell(d);
    paid += paidMinutes(p, d, c, r);
    ph += holidayMinutes(p, d, c, r);
    if (CODES[c]?.type) work++;
    if (c === "OFF") off++;
    if (c === "A/L") al++;
    if (c === "ML") ml++;
  }
  const contract = contractMinutes(p, month, r);
  const ot = Math.max(0, paid - contract);
  return {
    workDays: work, offDays: off, annualLeave: al, matPatLeave: ml,
    paidMinutes: paid, contractMinutes: contract, overtimeMinutes: ot, holidayMinutes: ph,
    payableExtraMinutes: ot * r.overtimeRate + ph * r.holidayRate,
  };
}

// ---------- Shift teams and checks ----------
export interface ShiftTeam { onShift: string[]; head: string | null; assistant: string | null }

export function shiftTeam(plant: string, day: string, shift: "D" | "N", staff: Person[], cell: (id: string, day: string) => Code): ShiftTeam {
  const loc = shift === "D" ? "DP" : "NP";
  const on = staff.filter((p) => p.plantOn(day) === plant && CODES[cell(p.id, day)]?.loc === loc);
  const head = on.find((p) => p.designation === "plant_technician") ?? on.find((p) => p.designation === "plant_technician_2");
  const asst = on.find(isAssistant);
  return { onShift: on.map((p) => p.id), head: head?.id ?? null, assistant: asst?.id ?? null };
}

export interface Problem { day: string; shift: "D" | "N"; message: string; blocking: boolean }

/** Same rules the database enforces on submit and approve, plus non-blocking notes. */
export function rosterProblems(plant: string, month: string, staff: Person[], cell: (id: string, day: string) => Code): Problem[] {
  const out: Problem[] = [];
  const name = (id: string) => staff.find((p) => p.id === id)?.name ?? id;
  for (const day of monthDays(month)) {
    const n = shiftTeam(plant, day, "N", staff, cell);
    if (n.onShift.length !== 2) out.push({ day, shift: "N", message: `night has ${n.onShift.length} on shift, needs exactly 2`, blocking: true });
    if (!n.head) out.push({ day, shift: "N", message: "night has no shift head", blocking: true });
    if (!n.assistant) out.push({ day, shift: "N", message: "night has no plant assistant", blocking: true });
    const d = shiftTeam(plant, day, "D", staff, cell);
    if (!d.head) out.push({ day, shift: "D", message: "day shift has no shift head", blocking: true });
    else if (d.onShift.length < 2) out.push({ day, shift: "D", message: "day shift one short, allowed because general staff are on site", blocking: false });
    else if (d.onShift.length > 2) out.push({ day, shift: "D", message: `day shift has ${d.onShift.length} on shift, the extra person adds cost`, blocking: false });
    const next = addDays(day, 1);
    if (next.slice(0, 7) === day.slice(0, 7)) {
      for (const p of staff) {
        if (p.plantOn(day) !== plant) continue;
        if (CODES[cell(p.id, day)]?.type === "N" && ["D", "G"].includes(CODES[cell(p.id, next)]?.type ?? "")) {
          out.push({ day: next, shift: "D", message: `${name(p.id)} works a day straight after a night`, blocking: true });
        }
      }
    }
  }
  return out;
}

// ---------- Cover ----------
export interface CoverOption { id: string; mode: "extend" | "full"; overtimeMinutes: number; holiday: boolean; restWaived: boolean }

/** Who can cover a gap, cheapest first. Relief, then (for a missing shift head) the PT II,
 *  then (for a missing assistant) a general-shift assistant, then staff on a day off. */
export function coverOptions(
  plant: string, day: string, shift: "D" | "N", slot: "head" | "asst",
  staff: Person[], cell: (id: string, day: string) => Code, r: Rules, allowNoRest = false,
): CoverOption[] {
  const month = day.slice(0, 7) + "-01";
  const here = staff.filter((p) => p.plantOn(day) === plant);
  const fits = (p: Person) => slot === "head" ? canHead(p) : isAssistant(p);
  const free = (p: Person) => {
    const c = CODES[cell(p.id, day)];
    if (!c || c.leave || c.type === "D" || c.type === "N") return false;
    if (allowNoRest) return true;
    if (shift === "D" && CODES[cell(p.id, addDays(day, -1))]?.type === "N") return false;
    if (shift === "N" && ["D", "G"].includes(CODES[cell(p.id, addDays(day, 1))]?.type ?? "")) return false;
    if (shift === "N" && c.type === "G") return false;      // already worked a general day; a night on top is 21 hours in 23
    return true;
  };
  const rank = (p: Person) => p.letter === "R" ? 0 : !isShiftTeam(p) ? 1 : 2;
  return here.filter((p) => fits(p) && free(p)).map((p) => {
    const before = monthSummary(p, month, (d) => cell(p.id, d), r).overtimeMinutes;
    const covered = (d: string) => (d === day ? coverCode(p, shift) : cell(p.id, d));
    const after = monthSummary(p, month, covered, r).overtimeMinutes;
    const mode: "extend" | "full" = !isShiftTeam(p) && shift === "D" && rotationCode(p, day, r) === "D" ? "extend" : "full";
    return { id: p.id, mode, overtimeMinutes: after - before, holiday: r.holidays.has(day) || (shift === "N" && r.holidays.has(addDays(day, 1))), restWaived: allowNoRest, _rank: rank(p) };
  }).sort((a, b) => a.overtimeMinutes - b.overtimeMinutes || a._rank - b._rank)
    .map(({ _rank, ...o }) => o);
}
