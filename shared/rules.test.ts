// Run: cd api && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RULES, rotationCode, contractMinutes, paidMinutes, holidayMinutes, monthSummary,
  rosterProblems, coverOptions, monthDays, shiftTeam,
  type Code, type Person, type Rules, type Letter, type Designation,
} from "./rules.ts";

const rules: Rules = {
  ...DEFAULT_RULES,
  holidays: new Set(["2026-10-09", "2026-12-25", "2026-12-26"]),
};

const person = (id: string, name: string, designation: Designation, letter: Letter, plant: string | null, moves: [string, string][] = []): Person => ({
  id, name, designation, letter,
  plantOn: (d) => moves.reduce((k, [from, to]) => (d >= from ? to : k), plant as string | null),
});

// Nyamwamba 1 HPP, November 2026 duty schedule, as imported
const ny1 = [
  person("ezra", "Ezra Kasaija", "plant_technician_2", "F", "n1"),
  person("denis", "Denis Mumbere", "plant_assistant", "G", "n1"),
  person("moses", "Moses Masereka", "plant_technician", "A", "n1"),
  person("joseph", "Joseph Maate", "plant_assistant", "A", "n1"),
  person("raphael", "Raphael Kambale", "plant_technician", "R", "n1", [["2026-11-07", "n2"]]),
  person("brenda", "Brenda Biira", "plant_technician", "B", "n1"),
  person("jevis", "Jevis Bwambale", "plant_assistant", "B", "n1"),
  person("augustine", "Augustine Mugisa", "plant_technician", "C", "n1"),
  person("samson", "Samson Abaho", "plant_assistant", "C", "n1"),
  person("martin", "Martin Bwambale", "sanitation_environment", "E", "n1"),
  person("amos", "Amos Kikenge", "machine_operator", "G", "n1"),
];
const NOV: Record<string, string> = {
  ezra: "OFF D D D D D OFF OFF D D D/P D D/P OFF OFF D D D/P D D OFF OFF D D D/P D D OFF OFF D",
  denis: "OFF D/P D D D/P D OFF OFF D/P D D D D OFF OFF D D/P D D/P D OFF OFF D D D D/P D OFF OFF D",
  moses: "N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P OFF N/P OFF N/P N/P N/P N/P OFF OFF N/P N/P N/P N/P",
  joseph: "N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P",
  raphael: "A/L A/L N/P N/P OFF OFF",
  brenda: "ML ML ML ML OFF OFF D/P D/P D/P D/P OFF OFF OFF D/P D/P D/P OFF OFF D/P D/P D/P D/P OFF OFF OFF D/P D/P D/P OFF OFF",
  jevis: "D/P OFF N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF",
  augustine: "OFF OFF D/P D/P N/P N/P OFF OFF N/P N/P N/P N/P OFF OFF N/P N/P N/P N/P OFF N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P",
  samson: "OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF D/P D/P N/P N/P OFF OFF OFF D/P N/P N/P",
  martin: "OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D",
  amos: "OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D D D D D OFF OFF D",
};
const novCell = (overrides: Record<string, Code> = {}) => (id: string, day: string): Code => {
  if (overrides[`${id}|${day}`] !== undefined) return overrides[`${id}|${day}`];
  if (!day.startsWith("2026-11")) return "OFF";
  return ((NOV[id] ?? "").split(" ")[+day.slice(8) - 1] ?? "") as Code;
};

test("rotation: 2 days, 2 nights, 2 off, crews 2 days apart", () => {
  const a = person("a", "A", "plant_technician", "A", "n2");
  const b = person("b", "B", "plant_technician", "B", "n2");
  const days = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"];
  assert.deepEqual(days.map((d) => rotationCode(a, d, rules)), ["D/P", "D/P", "N/P", "N/P", "OFF", "OFF", "D/P"]);
  assert.deepEqual(days.map((d) => rotationCode(b, d, rules)), ["OFF", "OFF", "D/P", "D/P", "N/P", "N/P", "OFF"]);
});

test("rotation: general shift off at weekends and public holidays; shift E works Saturdays", () => {
  const g = person("g", "G", "plant_technician_2", "F", "n2");
  const e = person("e", "E", "sanitation_environment", "E", "n2");
  assert.equal(rotationCode(g, "2026-12-25", rules), "OFF");   // Christmas, a Friday
  assert.equal(rotationCode(g, "2026-12-24", rules), "D");
  assert.equal(rotationCode(e, "2026-11-07", rules), "D");     // Saturday
  assert.equal(rotationCode(e, "2026-11-08", rules), "OFF");   // Sunday
});

test("contract: 48 h a week pro rata to the month", () => {
  const a = person("a", "A", "plant_technician", "A", "n2");
  assert.equal(contractMinutes(a, "2026-11-01", rules), Math.round(2880 * 30 / 7));   // 205.7 h
  assert.equal(contractMinutes(a, "2026-12-01", rules), Math.round(2880 * 31 / 7));   // 212.6 h
  const g = person("g", "G", "plant_technician_2", "F", "n2");
  assert.equal(contractMinutes(g, "2026-11-01", rules), 21 * 480);                     // 21 weekdays
});

test("pay: PT II covering a weekday day shift adds 2 hours; at the weekend a full 12", () => {
  const pt2 = ny1[0];
  assert.equal(paidMinutes(pt2, "2026-11-06", "D/P", rules), 600);   // Friday: 08:00-17:00 + 17:00-19:00
  assert.equal(paidMinutes(pt2, "2026-11-07", "D/P", rules), 720);   // Saturday
  assert.equal(paidMinutes(ny1[2], "2026-11-06", "N/P", rules), 720);
});

test("public holidays: the night before a holiday earns 7 holiday hours after midnight", () => {
  const a = person("a", "A", "plant_technician", "A", "n2");
  assert.equal(holidayMinutes(a, "2026-12-24", "N/P", rules), 7 * 60);
  assert.equal(holidayMinutes(a, "2026-12-25", "N/P", rules), 5 * 60 + 7 * 60);   // Christmas night runs into Boxing Day
  assert.equal(holidayMinutes(a, "2026-12-25", "D/P", rules), 12 * 60);
  assert.equal(holidayMinutes(a, "2026-12-23", "N/P", rules), 0);
});

test("Nyamwamba 1 November: every night is exactly 2; only 1 and 2 Nov lack a day shift head", () => {
  const problems = rosterProblems("n1", "2026-11-01", ny1, novCell()).filter((p) => p.blocking);
  assert.deepEqual(problems.map((p) => `${p.day} ${p.shift} ${p.message}`), [
    "2026-11-01 D day shift has no shift head",
    "2026-11-02 D day shift has no shift head",
  ]);
});

test("transfer: Raphael counts at Nyamwamba 1 until 6 Nov, then not", () => {
  const t = shiftTeam("n1", "2026-11-03", "N", ny1, novCell());
  assert.ok(t.onShift.includes("raphael"));
  assert.equal(ny1[4].plantOn("2026-11-07"), "n2");
});

test("cover: options come cheapest first; the PT II staying to 19:00 costs 2 h", () => {
  // Thu 12 Nov: Moses (crew A) is rostered D/P and reports sick. Raphael has moved to Nyamwamba 2.
  const sick = novCell({ "moses|2026-11-12": "S/L" });
  const opts = coverOptions("n1", "2026-11-12", "D", "head", ny1, sick, rules);
  const ezra = opts.find((o) => o.id === "ezra")!;
  assert.equal(ezra.mode, "extend");
  assert.equal(ezra.overtimeMinutes, 120);
  assert.ok(!opts.some((o) => o.id === "raphael"), "Raphael is at Nyamwamba 2 by then");
  for (let i = 1; i < opts.length; i++) assert.ok(opts[i - 1].overtimeMinutes <= opts[i].overtimeMinutes);
});

test("cover: relief who is under contract costs no overtime and comes first", () => {
  const sick = novCell({ "moses|2026-11-06": "S/L" });
  const opts = coverOptions("n1", "2026-11-06", "D", "head", ny1, sick, rules);
  assert.equal(opts[0].id, "raphael");
  assert.equal(opts[0].overtimeMinutes, 0);
});

test("cover: nobody is offered a day shift straight after their night", () => {
  const sick = novCell({ "brenda|2026-11-08": "S/L" });
  const opts = coverOptions("n1", "2026-11-08", "D", "head", ny1, sick, rules);
  assert.ok(!opts.some((o) => o.id === "moses"));                // Moses works the night of 7 Nov
});

test("summary: monthly overtime for a shift technician", () => {
  const s = monthSummary(ny1[2], "2026-11-01", (d) => novCell()("moses", d), rules);
  // The PDF summary says 20 work days, but Moses's row has 19 shifts and 11 days off (30 days).
  assert.equal(s.workDays, 19);
  assert.equal(s.offDays, 11);
  assert.equal(s.paidMinutes, 19 * 720);
  assert.equal(s.overtimeMinutes, 19 * 720 - Math.round(2880 * 30 / 7));   // 22.3 h
  assert.equal(monthDays("2026-11-01").length, 30);
});

test("a rotation-built month passes the night rule", () => {
  const ny2 = [
    person("fred", "Fred Onzima", "plant_technician_2", "F", "n2"),
    person("edinous", "Edinous Mumbere", "plant_technician", "A", "n2"),
    person("robert", "Robert Bwambale", "plant_assistant", "A", "n2"),
    person("lilian", "Lilian Tumusiime", "plant_technician", "B", "n2"),
    person("majid", "Majid Mawa", "plant_assistant", "B", "n2"),
    person("yubu", "Yubu Byabali", "plant_technician", "C", "n2"),
    person("adolf", "Adolf Ategeka", "plant_assistant", "C", "n2"),
  ];
  const cell = (id: string, d: string) => rotationCode(ny2.find((p) => p.id === id)!, d, rules);
  for (const m of ["2026-11-01", "2026-12-01", "2027-02-01"]) {
    assert.equal(rosterProblems("n2", m, ny2, cell).filter((p) => p.blocking).length, 0, m);
  }
});
