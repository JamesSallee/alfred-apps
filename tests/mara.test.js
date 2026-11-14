import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEntry, weekSummary, trend, recentBigReaction, phaseOf, QUIET } from "../js/mara.js";

const at = "2026-11-17T12:10:00.000Z";
const e = (day, trigger, react, extra = {}) => ({ day, at: `${day}T12:00:00.000Z`, trigger, react, ...extra });

test("an entry keeps only what makes sense", () => {
  assert.deepEqual(makeEntry({ day: "2026-11-17", trigger: "dog", react: "2", ft: "40", note: "  windy  " }, at),
    { day: "2026-11-17", at, trigger: "dog", react: 2, ft: 40, note: "windy" });
  assert.deepEqual(makeEntry({ day: "2026-11-17", trigger: "people", react: 0, ft: "" }, at), { day: "2026-11-17", at, trigger: "people", react: 0 });
  assert.deepEqual(makeEntry({ day: "2026-11-17", trigger: QUIET }, at), { day: "2026-11-17", at, trigger: QUIET });
  assert.equal(makeEntry({ day: "2026-11-17", trigger: "cat", react: 1 }, at), null);
  assert.equal(makeEntry({ day: "2026-11-17", trigger: "dog", react: 6 }, at), null);
  assert.equal(makeEntry({ day: "yesterday", trigger: "dog", react: 1 }, at), null);
});

test("a week sums moments by trigger and counts quiet walks apart", () => {
  const entries = [e("2026-11-16", "dog", 4), e("2026-11-17", "dog", 2), e("2026-11-18", "people", 3), { day: "2026-11-19", trigger: QUIET }, e("2026-11-23", "dog", 0)];
  const w = weekSummary(entries, "2026-11-16");
  assert.equal(w.n, 3);
  assert.equal(w.quiet, 1);
  assert.equal(w.avg, 3);
  assert.deepEqual(w.by.dog, { n: 2, avg: 3, worst: 4 });
  assert.equal(w.by.mail, undefined);
});

test("the trend runs oldest first with empty weeks as null", () => {
  const entries = [e("2026-11-03", "dog", 4), e("2026-11-17", "dog", 2), e("2026-11-18", "people", 1)];
  assert.deepEqual(trend(entries, "2026-11-19", 3).map((w) => w.avg), [4, null, 1.5]);
});

test("a big reaction in the last two days is flagged, an older one isn't", () => {
  const entries = [e("2026-11-14", "dog", 5), e("2026-11-17", "people", 4), e("2026-11-18", "dog", 2)];
  assert.equal(recentBigReaction(entries, "2026-11-19").day, "2026-11-17");
  assert.equal(recentBigReaction(entries, "2026-11-21"), null);
});

test("the phase defaults to the first", () => {
  assert.equal(phaseOf({}).n, 1);
  assert.equal(phaseOf({ mara: { phase: 3 } }).n, 3);
  assert.equal(phaseOf({ mara: { phase: 9 } }).n, 1);
});
