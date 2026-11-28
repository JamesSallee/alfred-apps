import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, habitFor, tickables, habitsOnCalendar, isTicked, unanswered, jobPoints, deskSlip, dayJobPoints, tasksToFinish } from "../js/calendar.js";
import { scoreWeek, settingsOf, gateOpen } from "../js/money.js";

const habits = [
  { id: "write", name: "Write" }, { id: "workout", name: "Workout" }, { id: "piano", name: "Piano" },
  { id: "walk-mara", name: "Walk Mara" }, { id: "bootcamp", name: "Coding bootcamp" }, { id: "tidy", name: "Tidy up for ten minutes" },
  { id: "meditate", name: "Meditate" },
];
const at = (h, m = 0) => `2026-11-28T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00-05:00`;
const ev = (id, title, h1, h2, extra = {}) => ({ id, title, start: at(...h1), end: at(...h2), ...extra });
const noon = new Date(at(12));

test("titles lose the ◆, the + and the Chore label", () => {
  assert.deepEqual(cleanTitle("◆ Chore · Laundry: dryer swap"), { text: "laundry: dryer swap", display: "Laundry: dryer swap", chore: true, plus: false, alfred: true });
  assert.equal(cleanTitle("+ Hardware store").plus, true);
  assert.equal(cleanTitle("◆ +odd").plus, false);
});

test("Alfred's real block titles find their habits", () => {
  assert.deepEqual(habitFor("Write: LIRR stations ranking", habits), { id: "write", variant: null });
  assert.deepEqual(habitFor("Strength", habits), { id: "workout", variant: "strength" });
  assert.deepEqual(habitFor("Easy ride", habits), { id: "workout", variant: "cardio" });
  assert.deepEqual(habitFor("Yoga", habits), { id: "workout", variant: "yoga" });
  assert.deepEqual(habitFor("Coding", habits), { id: "bootcamp", variant: null });
  assert.deepEqual(habitFor("Walk Mara", habits), { id: "walk-mara", variant: null });
  assert.equal(habitFor("Writer's lunch", habits), null);
  assert.equal(habitFor("Dinner with Sam", habits), null);
});

test("what is tickable follows the agreed split", () => {
  const tasks = [
    { id: "laundry", title: "Laundry", size: 60, booked: { start: at(9, 10), end: at(17, 40) } },
    { id: "damp", title: "Basement damp check", size: 5, booked: { start: at(9, 10), end: at(9, 25) } },
    { id: "depop", title: "Mail out depop shirt" },
  ];
  const events = [
    ev("e1", "◆ Write: LIRR stations ranking", [8], [9], { alfred: true }),
    ev("e2", "◆ Chore · Laundry: load + basement check", [9, 10], [9, 25], { alfred: true }),
    ev("e3", "◆ Unplanned", [13], [15], { alfred: true }),
    ev("e4", "Dinner at Marco's", [19], [21]),
    ev("e5", "+ Hardware store", [11], [11, 45]),
    ev("e6", "Mail out Depop shirt", [10], [10, 20]),
    ev("e7", "◆ Pack for Vegas", [16], [17], { alfred: true }),
    ev("e8", "Office tidy", [17], [17, 30], { rid: "weekly-tidy" }),
  ];
  const items = tickables({ events, habits, tasks, hidden: ["weekly-tidy"], now: noon });
  const by = Object.fromEntries(items.map((i) => [i.eventId, i]));
  assert.equal(by.e1.kind, "habit");
  assert.equal(by.e1.ended, true);
  assert.deepEqual(by.e2.taskIds.sort(), ["damp", "laundry"]); // one block, two booked tasks
  assert.equal(by.e3, undefined);  // protected rest
  assert.equal(by.e4, undefined);  // plain calendar
  assert.equal(by.e5.kind, "plus");
  assert.equal(by.e5.points, 3);   // 45 minutes
  assert.deepEqual(by.e6.taskIds, ["depop"]); // own event matching an open task
  assert.equal(by.e7.kind, "block");
  assert.equal(by.e8, undefined);  // hidden by its recurring id
  assert.deepEqual([...habitsOnCalendar(items)], ["write"]);
  assert.deepEqual(items.map((i) => i.eventId), ["e1", "e2", "e6", "e5", "e7"]); // time order
});

test("ticked and unanswered", () => {
  const tasks = { depop: { status: "done" } };
  const items = tickables({ events: [ev("e1", "◆ Piano", [8], [8, 30], { alfred: true }), ev("e6", "Mail out Depop shirt", [9], [9, 20]), ev("e9", "◆ Pack", [10], [11], { alfred: true })],
    habits, tasks: [{ id: "depop", title: "Mail out depop shirt", status: "todo" }], now: noon });
  const day = { done: {}, cal: { e9: "skip", e1: "later" } };
  assert.deepEqual(unanswered(items, day, {}).map((i) => i.eventId), ["e1", "e6"]);
  assert.equal(isTicked(items[1], day, tasks), true);
  assert.deepEqual(unanswered(items, { done: { piano: true }, cal: { e9: "skip" } }, tasks).map((i) => i.eventId), []);
});

test("an own event stops matching a task once it's done elsewhere", () => {
  const items = tickables({ events: [ev("e6", "Mail out Depop shirt", [9], [9, 20])], habits, tasks: [{ id: "depop", title: "Mail out depop shirt", status: "done" }], now: noon });
  assert.equal(items.length, 0);
});

test("job points: a point per 15 minutes, 1 to 8", () => {
  assert.equal(jobPoints(5), 1);
  assert.equal(jobPoints(60), 4);
  assert.equal(jobPoints(240), 8);
  assert.equal(dayJobPoints({ jobs: { a: { pts: 2 }, b: { pts: 3 } } }), 5);
});

test("jobs add points up to the weekly cap but never count as habits", () => {
  const cfg = settingsOf({});
  const days = { "2026-11-23": { done: {}, jobs: { a: { pts: 8 }, b: { pts: 8 } } }, "2026-11-24": { done: {}, jobs: { c: { pts: 8 } } } };
  const w = scoreWeek({ habits: [], days, wk: "2026-11-23", cfg, upTo: "2026-11-29" });
  assert.equal(w.jobsRaw, 24);
  assert.equal(w.jobs, 20);
  assert.equal(w.points, 20);
  assert.equal(gateOpen({ gateAny: 2 }, days["2026-11-23"]), false); // the PlayStation stays shut
});

test("a skipped Write moves the Desk date once, within the rhythm", () => {
  const p = { id: "lirr", title: "Ranking: LIRR stations", publish: "2027-01-20", draft: "2026-11-28", due: "2027-01-19" };
  assert.deepEqual(deskSlip([p], "2026-11-28", "2026-11-28"), { piece: p, field: "draft", from: "2026-11-28", to: "2026-11-29" });
  assert.equal(deskSlip([{ ...p, slips: { draft: 1 } }], "2026-11-28", "2026-11-28").why, "once");
  const tight = { id: "t", publish: "2026-12-09", draft: "2026-12-07", due: "2026-12-08" };
  assert.equal(deskSlip([tight], "2026-12-07", "2026-12-07").to, "2026-12-08");
  assert.equal(deskSlip([tight], "2026-12-07", "2026-12-08").why, "no-room");
  assert.equal(deskSlip([p], "2026-11-27", "2026-11-28"), null);
});

test("a job with several blocks finishes on its last block", () => {
  const tasks = [{ id: "laundry", title: "Laundry", size: 60, booked: { start: at(9, 10), end: at(17, 40) } }];
  const items = tickables({ events: [ev("l1", "◆ Chore · Laundry: load", [9, 10], [9, 25], { alfred: true }), ev("l2", "◆ Chore · Laundry: fold", [17], [17, 40], { alfred: true })], habits, tasks, now: noon });
  assert.deepEqual(tasksToFinish(items[0], {}), []);
  assert.deepEqual(tasksToFinish(items[1], { jobs: { "e:l1": { pts: 1 } } }), ["laundry"]);
  assert.equal(isTicked(items[0], { jobs: { "e:l1": { pts: 1 } } }, {}), true);
  assert.equal(isTicked(items[1], { jobs: { "e:l1": { pts: 1 } } }, {}), false);
});
