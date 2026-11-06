// App state: the signed-in person, reference data from /api/bootstrap, and roster loading.
import { get } from "./api.js";
import { DEFAULT_RULES, rotationCode, monthDays } from "../../shared/rules.ts";
import { today } from "./ui.js";

export const S = {
  me: null,          // { id, full_name, designation, app_role, shift_letter, plant }
  boot: null,        // staff, assignments, plants, shifts, holidays, settings
  people: [],        // staff as the rules module expects them
  rules: null,
  rosters: new Map(),// "plant|month" -> { roster, cells: Map, problems, covers }
};

export const DESIGNATION = {
  plant_manager: "Plant Manager", maintenance_supervisor: "Maintenance Supervisor", site_admin: "Site Admin",
  ehs_officer: "EHS Officer", plant_technician_2: "Plant Technician II", plant_technician: "Plant Technician",
  plant_assistant: "Plant Assistant", sanitation_environment: "Sanitation & Environment", machine_operator: "Machine Operator",
};
export const LEAVE = {
  annual: { name: "Annual leave", code: "A/L" }, sick: { name: "Sick leave", code: "S/L" }, casual: { name: "Casual leave", code: "C/L" },
  maternity_paternity: { name: "Maternity/Paternity leave", code: "ML" }, unpaid: { name: "Unpaid leave", code: "U/L" },
};
export const CODE_LABEL = {
  "D/P": "Day shift, power house", "N/P": "Night shift, power house", "N/W": "Night shift, weir", "D": "Day, general",
  "O.T D/P": "Overtime day shift", "O.T N/P": "Overtime night shift", "OFF": "Off", "A/L": "Annual leave",
  "S/L": "Sick leave", "C/L": "Casual leave", "ML": "Maternity/Paternity leave", "U/L": "Unpaid leave", "": "Not on the schedule",
};

export async function loadBoot() {
  const b = await get("/api/bootstrap");
  S.boot = b; S.me = b.me;
  const assign = new Map();
  for (const a of b.assignments) { if (!assign.has(a.staff_id)) assign.set(a.staff_id, []); assign.get(a.staff_id).push(a); }
  const plantOn = (id) => {
    const list = (assign.get(id) ?? []).sort((x, y) => x.from_date.localeCompare(y.from_date));
    return (d) => { let k = null; for (const a of list) if (a.from_date <= d) k = a.plant_id; return k; };
  };
  S.people = b.staff.filter((s) => s.active).map((s) => ({
    id: s.id, name: s.full_name, designation: s.designation, letter: s.shift_letter, plantOn: plantOn(s.id),
    empNo: s.emp_no, appRole: s.app_role, hasSignIn: s.has_sign_in,
  }));
  const st = b.settings ?? {};
  S.rules = {
    ...DEFAULT_RULES,
    holidays: new Set(b.holidays.map((h) => h.day)),
    rotation: st.rotation?.cycle ? { cycle: st.rotation.cycle, offsets: st.rotation.offsets ?? DEFAULT_RULES.rotation.offsets, anchor: st.rotation.anchor } : DEFAULT_RULES.rotation,
    shiftWeeklyMinutes: (st.contract?.shift_weekly_hours ?? 48) * 60,
    generalDailyMinutes: (st.contract?.general_daily_hours ?? 8) * 60,
    overtimeRate: st.rates?.overtime ?? 1.5,
    holidayRate: st.rates?.public_holiday ?? 2,
    pt2ExtendMinutes: st.cover?.pt2_extend_minutes ?? 120,
  };
  S.rosters.clear();
}

export const person = (id) => S.people.find((p) => p.id === id);
export const plantName = (k) => S.boot?.plants.find((p) => p.id === k)?.name ?? "Both plants";
export const myPerson = () => person(S.me.id);
export const myPlant = () => S.me.plant;
export const holidayName = (d) => S.boot.holidays.find((h) => h.day === d)?.name;
export const role = () => S.me.app_role;
export const canHeadRole = (p) => p.designation === "plant_technician" || p.designation === "plant_technician_2";

/** Roster for a plant and month, with cells as a Map("staffId|day" -> code). */
export async function loadRoster(plant, month, force = false) {
  const key = `${plant}|${month}`;
  if (!force && S.rosters.has(key)) return S.rosters.get(key);
  const r = await get(`/api/rosters/${plant}/${month.slice(0, 7)}`);
  const cells = new Map(r.cells.map((c) => [`${c.staff_id}|${c.day}`, c.code]));
  const sources = new Map(r.cells.map((c) => [`${c.staff_id}|${c.day}`, c.source]));
  const out = { ...r, cells, sources };
  S.rosters.set(key, out);
  return out;
}
export const forgetRoster = (plant, month) => S.rosters.delete(`${plant}|${month}`);

/** A code lookup for a roster. With no roster yet, falls back to the rotation (a preview). */
export function cellLookup(r) {
  return (id, day) => {
    const v = r?.roster ? r.cells.get(`${id}|${day}`) : undefined;
    if (v !== undefined) return v;
    if (r?.roster) return "";
    const p = person(id);
    return p ? rotationCode(p, day, S.rules) : "";
  };
}

/** Everyone who works at a plant at some point in a month. */
export const peopleAt = (plant, month) => S.people.filter((p) => monthDays(month).some((d) => p.plantOn(d) === plant));

/** A stable random ID for this browser, used to flag one phone clocking in several people. */
export function browserId() {
  try {
    let id = localStorage.getItem("shiftbook_browser");
    if (!id) { id = crypto.randomUUID(); localStorage.setItem("shiftbook_browser", id); }
    return id;
  } catch { return null; }
}
export const isToday = (d) => d === today();
