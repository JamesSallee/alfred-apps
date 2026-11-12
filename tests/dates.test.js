import { test } from "node:test";
import assert from "node:assert/strict";
import { ymd, addDays, mondayOf, daysBetween, parse } from "../js/dates.js";

test("addDays crosses month ends and the clocks going back", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02"); // US clocks go back on 1 Nov 2026
  assert.equal(addDays("2026-03-08", -1), "2026-03-07"); // and forward on 8 Mar
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("mondayOf treats Sunday as the end of the week", () => {
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-12"), "2026-11-09");
  assert.equal(mondayOf("2026-11-15"), "2026-11-09");
  assert.equal(mondayOf("2026-11-16"), "2026-11-16");
});

test("daysBetween and ymd round-trip", () => {
  assert.equal(daysBetween("2026-10-30", "2026-11-06"), 7);
  assert.equal(ymd(parse("2026-02-28")), "2026-02-28");
});
