import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { fold, queryWords, parseQuery, searchTasks, highlight, snippet } = await import("../js/search.js");
const T = "2026-11-28";
const tasks = [
  { id: "a", title: "Renew car registration", area: "Car", status: "todo", due: "2026-12-05" },
  { id: "b", title: "Ring the plumber", area: "Home", status: "waiting", waitingOn: "Quote for the boiler" },
  { id: "c", title: "Fix the gate", area: "Home", status: "todo", notes: "Bring the car jack from the garage" },
  { id: "d", title: "Car wash", area: "Car", status: "done", doneAt: "2026-10-01T10:00:00Z" },
  { id: "e", title: "Car mats", area: "Car", status: "done", doneAt: "2026-11-20T10:00:00Z" },
  { id: "f", title: "Book the Café Rouge table", area: "Family", status: "todo", someday: true },
  { id: "g", title: "Car insurance", area: "Car", status: "todo", snoozeUntil: "2026-12-10" },
];
const ids = (q) => searchTasks(tasks, q, T).map((x) => x.id);

test("an empty query finds nothing", () => { assert.deepEqual(ids("   "), []); });

test("every word must match, in any order, across title, notes, area and waiting on", () => {
  assert.deepEqual(ids("registration car"), ["a"]);
  assert.deepEqual(ids("boiler"), ["b"], "waiting on is searched");
  assert.deepEqual(ids("jack"), ["c"], "notes are searched");
  assert.deepEqual(ids("family"), ["f"], "area is searched");
});

test("case and accents don't count", () => {
  assert.equal(fold("Café ÉCLAIR"), "cafe eclair");
  assert.deepEqual(ids("CAFE"), ["f"]);
});

test("open first, then snoozed or waiting, then Someday, then done newest first; title matches lead", () => {
  assert.deepEqual(ids("car"), ["a", "c", "g", "e", "d"]);
});

test("matches are marked in the original text, and the rest is escaped", () => {
  assert.equal(highlight("Café <b>", queryWords("cafe")), "<mark>Café</mark> &lt;b&gt;");
  assert.equal(highlight("Carpet car", queryWords("car carpet")), "<mark>Carpet</mark> <mark>car</mark>");
  assert.equal(highlight("No match", queryWords("zz")), "No match");
});

test("a notes snippet sits around the first match", () => {
  const s = snippet("x ".repeat(60) + "the car jack " + "y ".repeat(60), ["jack"]);
  assert.ok(s.startsWith("…") && s.endsWith("…") && s.includes("car jack"));
});

test("shortcut words filter rather than match text", () => {
  const more = [...tasks,
    { id: "h", title: "Pay the council tax", priority: "High", status: "todo", due: "2026-11-20" },
    { id: "i", title: "Service the boiler", status: "todo", planFor: "2026-12" },
    { id: "j", title: "Car MOT", area: "Car", status: "todo", booked: { start: "2027-01-14T09:00:00Z" } },
    { id: "k", title: "Spring clean the shed", status: "todo", planFor: "2027-03-02" },
  ];
  const f = (q) => searchTasks(more, q, T).map((x) => x.id);
  assert.deepEqual(f("high"), ["h"]);
  assert.deepEqual(f("overdue"), ["h"]);
  assert.deepEqual(f("waiting"), ["b"]);
  assert.deepEqual(f("booked car"), ["j"]);
  assert.deepEqual(f("december"), ["a", "i"], "planned for or due in December");
  assert.deepEqual(f("jan"), ["j"], "January means next January");
  assert.deepEqual(f("march"), ["k"], "a planned week counts in its month");
  assert.deepEqual(f("car done"), ["e", "d"]);
  assert.deepEqual(f("car open"), ["a", "j", "c", "g"]);
  const { words, filters } = parseQuery("High boiler DEC dec", T);
  assert.deepEqual(words, ["boiler"]);
  assert.deepEqual(filters.map((x) => x.label), ["High priority", "December"]);
});
