import "./setup.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeStore } from "./setup.js";

const { tickWorkouts, tickWriting, todoBucket } = await import("../js/rooms.js");
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

test("errands sort into today, this week, later and someday", () => {
  const t = "2026-11-12";
  assert.equal(todoBucket({ due: "2026-11-11" }, t), "today");
  assert.equal(todoBucket({ status: "doing" }, t), "today");
  assert.equal(todoBucket({ due: "2026-11-18" }, t), "week");
  assert.equal(todoBucket({ due: "2026-11-19" }, t), "later");
  assert.equal(todoBucket({ someday: true, due: t }, t), "someday");
  assert.equal(todoBucket({ booked: { start: "2026-11-12T10:00:00" } }, t), "today");
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
