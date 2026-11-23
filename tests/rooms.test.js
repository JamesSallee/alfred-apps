import "./setup.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeStore } from "./setup.js";

const { tickWorkouts, tickWriting, todoBucket, planLabel, nextRepeat, repeatLabel } = await import("../js/rooms.js");
const { parseFocusPlan } = await import("../js/study.js");

mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-12T15:00:00") });

test("a Peloton class ticks the Ledger once, strength winning the day", () => {
  const ledger = fakeStore({ "habits/workout": { name: "Workout", variants: [{ key: "strength" }, { key: "cardio" }, { key: "yoga" }] } });
  const training = fakeStore({
    "workouts/a": { id: "a", discipline: "cycling", class_id: "c1", start: "2026-11-11T07:00:00", minutes: 30, title: "Ride" },
    "workouts/b": { id: "b", discipline: "strength", start: "2026-11-11T18:00:00", minutes: 20, title: "Arms" },
  });
  const ticked = tickWorkouts(ledger, training);
  assert.deepEqual(ticked.map((t) => [t.day, t.kind]), [["2026-11-11", "strength"]]);
  assert.equal(ledger.get("days/2026-11-11").done.workout, "strength");
  assert.ok(training.get("ticked/a") && training.get("ticked/b"));
  assert.deepEqual(tickWorkouts(ledger, training), [], "the second run finds nothing new");
});

test("an untick in the Ledger sticks, and nothing happens before both stores have synced", () => {
  const ledger = fakeStore({ "habits/workout": { name: "Workout" } });
  const training = fakeStore({ "workouts/a": { id: "a", discipline: "strength", start: "2026-11-11T07:00:00" }, "ticked/a": { day: "2026-11-11" } });
  assert.deepEqual(tickWorkouts(ledger, training), []);
  const early = fakeStore({ "habits/workout": { name: "Workout" } }, "syncing");
  const t2 = fakeStore({ "workouts/b": { id: "b", discipline: "strength", start: "2026-11-11T07:00:00" } });
  assert.deepEqual(tickWorkouts(early, t2), []);
});

test("a Writing session ticks the write habit for its day", () => {
  const ledger = fakeStore({ "habits/write": { name: "Write" } });
  const t = new Date("2026-11-10T08:00:00").getTime();
  const focus = fakeStore({ [`log/${t}`]: { k: "focus", label: "Writing", t, m: 45 }, "log/x": { k: "focus", label: "Piano", t: t + 1, m: 30 } });
  const ticked = tickWriting(ledger, focus);
  assert.deepEqual(ticked, [{ day: "2026-11-10", minutes: 45 }]);
  assert.equal(ledger.get("days/2026-11-10").done.write, true);
});

test("errands sort into today, this week, this month, later and someday", () => {
  const t = "2026-11-12";
  assert.equal(todoBucket({ due: "2026-11-11" }, t), "today");
  assert.equal(todoBucket({ status: "doing" }, t), "today");
  assert.equal(todoBucket({ due: "2026-11-18" }, t), "week");
  assert.equal(todoBucket({ due: "2026-11-19" }, t), "month");
  assert.equal(todoBucket({ due: "2026-12-01" }, t), "later");
  assert.equal(todoBucket({ someday: true, due: t }, t), "someday");
  assert.equal(todoBucket({ booked: { start: "2026-11-12T10:00:00" } }, t), "today");
});

test("a planned month or week places an errand without a due date", () => {
  const t = "2026-11-12"; // a Thursday; its week began Mon 9 Nov
  assert.equal(todoBucket({ planFor: "2026-11" }, t), "month");
  assert.equal(todoBucket({ planFor: "2026-12" }, t), "later");
  assert.equal(todoBucket({ planFor: "2026-11-09" }, t), "week");
  assert.equal(todoBucket({ planFor: "2026-11-02" }, t), "week", "a slipped week stays in view");
  assert.equal(todoBucket({ planFor: "2026-11-16" }, t), "month");
  assert.equal(todoBucket({ planFor: "2026-12", due: "2026-11-12" }, t), "today", "a real deadline wins");
  assert.equal(planLabel("2026-12", t), "December");
  assert.equal(planLabel("2027-04", t), "April 2027");
  assert.equal(planLabel("2026-12-07", t), "w/c 7 Dec");
});

test("ticking off a repeating errand makes the next one, on schedule", () => {
  const yearly = nextRepeat({ id: "a", title: "Radon retest", due: "2027-12-15", repeats: { n: 2, unit: "year" }, booked: { start: "x" }, doneAt: "y", wantsSlot: true }, "2027-12-20");
  assert.equal(yearly.due, "2029-12-15");
  assert.equal(yearly.planFor, "2029-12");
  assert.equal(yearly.status, "todo");
  assert.equal(yearly.booked, null);
  assert.equal(yearly.repeatOf, "a");
  assert.ok(!("doneAt" in yearly) && !("id" in yearly));
  const monthly = nextRepeat({ id: "b", title: "Check Uniqlo sales", planFor: "2026-12-07", repeats: { n: 1, unit: "month" } }, "2026-12-09");
  assert.equal(monthly.planFor, "2027-01");
  assert.equal(monthly.due, null);
  assert.equal(nextRepeat({ id: "c", due: "2027-01-31", repeats: { n: 1, unit: "month" } }).due, "2027-02-28", "short months clamp");
  assert.equal(nextRepeat({ id: "d", title: "One-off" }), null);
  assert.equal(repeatLabel({ n: 3, unit: "month" }), "every 3 months");
  assert.equal(repeatLabel({ n: 1, unit: "year" }), "every year");
});

test("a pasted Focus Plan is read into blocks and hard stops", () => {
  const text = [
    "FOCUS PLAN",
    "Mon F1 · 9:00–10:30",
    "Tue F2 · 2pm-3:30pm · overflow",
    "Wed F3 · 1:00 – 2:00",
    "not a block",
    "Personal constraints",
    "Hard stop: 5:30pm on Mon, 4pm on Thu",
  ].join("\n");
  const { blocks, hardStops } = parseFocusPlan(text, "2026-11-09");
  assert.deepEqual(blocks, [
    { day: "2026-11-09", id: "F1", start: "09:00", end: "10:30", overflow: false },
    { day: "2026-11-10", id: "F2", start: "14:00", end: "15:30", overflow: true },
    { day: "2026-11-11", id: "F3", start: "13:00", end: "14:00", overflow: false },
  ]);
  assert.deepEqual(hardStops, { "2026-11-09": "17:30", "2026-11-12": "16:00" });
});
