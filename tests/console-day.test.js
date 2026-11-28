import { test } from "node:test";
import assert from "node:assert/strict";
import { isEveningHabit, isOutdoor, hourAt, blockWeather, whatToWear, nextTrip, daysAway, nextDeskDate } from "../js/console-day.js";

test("evening habits stay off the console", () => {
  assert.equal(isEveningHabit({ name: "In bed by 11" }), true);
  assert.equal(isEveningHabit({ name: "Meditate" }), false);
  assert.equal(isEveningHabit({ name: "Stretch", when: "evening" }), true);
});

test("outdoor blocks by title", () => {
  assert.equal(isOutdoor("◆ Walk Mara"), true);
  assert.equal(isOutdoor("◆ Chore · Mara care + yard pick-up"), true);
  assert.equal(isOutdoor("Winterizer"), true);
  assert.equal(isOutdoor("◆ Strength"), false);
  assert.equal(isOutdoor("Laundry: dryer swap"), false);
  assert.equal(isOutdoor("Treadmill walk"), false);
});

const hours = Array.from({ length: 24 }, (_, h) => `2026-11-28T${String(h).padStart(2, "0")}:00`);
const hourly = { time: hours, temperature_2m: hours.map((_, h) => 30 + h), precipitation_probability: hours.map((_, h) => (h >= 16 ? 80 : 10)), weather_code: hours.map(() => 3) };

test("the forecast for a block, and a drier hour when rain is likely", () => {
  assert.deepEqual(hourAt(hourly, "2026-11-28T10:30"), { temp: 40, rain: 10, code: 3 });
  const now = new Date(2026, 10, 28, 9, 0), sunset = new Date(2026, 10, 28, 16, 31);
  const dry = blockWeather({ start: new Date(2026, 10, 28, 10, 0), hourly, sunset, now });
  assert.equal(dry.text, "Dry"); assert.equal(dry.better, null);
  const wet = blockWeather({ start: new Date(2026, 10, 28, 16, 30), hourly, sunset, now });
  assert.match(wet.text, /^Rain likely \(80%\)/);
  assert.equal(wet.warn, true);
  assert.equal(wet.better.getHours(), 15); // the nearest dry hour before dark
  const late = blockWeather({ start: new Date(2026, 10, 28, 17, 0), hourly, sunset, now });
  assert.match(late.text, /after dark/);
});

test("what to wear: the Wardrobe's outfit first, else a rule naming his own pieces", () => {
  const pieces = [{ id: "a", name: "Navy hooded parka", category: "Coat" }, { id: "b", name: "Charcoal waxed-canvas chore jacket", category: "Jacket" },
    { id: "c", name: "Olive field jacket", category: "Jacket" }, { id: "d", name: "Black pull-on work boots", category: "Shoes" }];
  assert.deepEqual(whatToWear({ outfit: { outfits: [{ name: "Weekend layers", piece_ids: ["c", "d"] }] }, pieces, temp: 40 }),
    { lead: "Today's outfit: Weekend layers", pieces: ["Olive field jacket", "Black pull-on work boots"] });
  assert.deepEqual(whatToWear({ pieces, temp: 30 }), { lead: "Coat weather", pieces: ["Navy hooded parka"] });
  assert.deepEqual(whatToWear({ pieces, temp: 44, rain: 70 }), { lead: "A jacket", pieces: ["Charcoal waxed-canvas chore jacket", "Black pull-on work boots"] });
  assert.equal(whatToWear({ pieces, temp: 70 }).lead, "No layer needed");
  assert.equal(whatToWear({ pieces }), null);
});

test("the next trip: the flight, the leave-for block that day, and the flight back", () => {
  const docs = [
    { day: "2026-11-28", events: [{ title: "◆ Walk Mara", start: "2026-11-28T10:00:00-05:00" }] },
    { day: "2026-11-29", events: [{ title: "◆ Leave for the airport", start: "2026-11-29T18:30:00-05:00" }, { title: "Flight to Lisbon", start: "2026-11-29T21:25:00-05:00" }] },
    { day: "2026-12-04", events: [{ title: "Flight home", start: "2026-12-04T09:00:00-08:00" }] },
  ];
  const t = nextTrip(docs, new Date("2026-11-28T09:24:00-05:00"));
  assert.equal(t.where, "Lisbon"); assert.equal(t.day, "2026-11-29");
  assert.equal(t.leave.title, "Leave for the airport"); assert.equal(t.back, "2026-12-04");
  assert.equal(nextTrip([docs[0]], new Date()), null);
  assert.equal(daysAway("2026-11-28", "2026-11-29"), "Tomorrow");
  assert.equal(daysAway("2026-11-28", "2026-12-04"), "6 days");
});

test("the next Writing Desk date after today", () => {
  const pieces = [{ track: "ilkwim", stage: "Sketch", title: "Apartments", draft: "2026-12-07", due: "2026-12-08", publish: "2026-12-09" },
    { track: "ilkwim", stage: "Gather", title: "Tribeca", gathers: ["2026-11-21", "2026-12-06"], publish: "2027-01-06" },
    { track: "fiction", title: "Time capsule", draft: "2026-11-30" }, { track: "ilkwim", stage: "Out", title: "Old", publish: "2026-11-30" }];
  assert.deepEqual(nextDeskDate(pieces, "2026-11-28"), { day: "2026-12-06", label: "Gather", title: "Tribeca" });
  assert.deepEqual(nextDeskDate(pieces, "2026-12-06"), { day: "2026-12-07", label: "Draft", title: "Apartments" });
});
