import { test } from "node:test";
import assert from "node:assert/strict";
import { MONEY_DEFAULTS, settingsOf, scoreWeek, phoneTargets, wallet, targetFor, fmtUsd } from "../js/money.js";

const cfg = settingsOf({});
const wk = "2026-11-09";
const habit = (id, points, extra = {}) => ({ id, name: id, points, ...extra });
const tick = (dates, ids) => Object.fromEntries(dates.map((d) => [d, { done: Object.fromEntries(ids.map((i) => [i, true])) }]));

test("settings fall back to the defaults, phone settings merged", () => {
  const s = settingsOf({ money: { monthly: 400, phone: { floor: 3 } } });
  assert.equal(s.monthly, 400);
  assert.equal(s.goodWeek, MONEY_DEFAULTS.goodWeek);
  assert.equal(s.phone.floor, 3);
  assert.equal(s.phone.start, MONEY_DEFAULTS.phone.start);
});

test("a week scores ticks times points, and a met target adds its bonus", () => {
  const habits = [habit("piano", 2, { bonusAt: 3, bonus: 10 })];
  const days = tick(["2026-11-09", "2026-11-10", "2026-11-11"], ["piano"]);
  const w = scoreWeek({ habits, days, wk, cfg, upTo: "2026-11-15" });
  assert.equal(w.base, 6);
  assert.equal(w.points, 16);
  assert.deepEqual(w.bonuses.map((b) => b.habit), ["piano"]);
});

test("points over the cap don't pay", () => {
  const habits = [habit("big", 100)];
  const days = tick(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"], ["big"]);
  const w = scoreWeek({ habits, days, wk, cfg, upTo: "2026-11-15" });
  assert.equal(w.points, 500);
  assert.equal(w.counted, cfg.cap);
  assert.equal(w.over, 100);
});

test("a light week shrinks targets but pays the same per good week", () => {
  assert.equal(targetFor({ bonusAt: 5 }, cfg, true, 0), 3);
  assert.equal(targetFor({ bonusAt: 5, kind: "daily" }, cfg, false, 2), 3);
  assert.equal(targetFor({ bonusAt: 0 }, cfg, false, 0), 0);
  const habits = [habit("h", 10)];
  const days = tick(["2026-11-09"], ["h"]);
  const normal = scoreWeek({ habits, days, wk, cfg, upTo: "2026-11-15" });
  const light = scoreWeek({ habits, days, wk, meta: { light: true }, cfg, upTo: "2026-11-15" });
  assert.ok(light.dollars > normal.dollars);
});

test("days after upTo don't count yet", () => {
  const habits = [habit("h", 10)];
  const days = tick(["2026-11-09", "2026-11-14"], ["h"]);
  assert.equal(scoreWeek({ habits, days, wk, cfg, upTo: "2026-11-12" }).base, 10);
});

test("phone targets step down after two weeks hit, never below the floor", () => {
  const weeks = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map((wk) => ({ wk, phone: 3 }));
  const { byWeek, next } = phoneTargets(weeks, cfg);
  assert.equal(byWeek["2026-11-02"], 6);
  assert.equal(byWeek["2026-11-16"], 5.5);
  assert.equal(next, 5);
  const many = Array.from({ length: 30 }, (_, i) => ({ wk: String(i), phone: 1 }));
  assert.equal(phoneTargets(many, cfg).next, cfg.phone.floor);
});

test("the wallet never shows more than the bank balance allows", () => {
  const weeks = [{ dollars: 100, current: false }, { dollars: 50, current: true }];
  const spends = [{ dollars: 30, at: "2026-11-10T10:00:00Z" }];
  assert.equal(wallet({ weeks, spends, bank: null }).available, 120);
  const capped = wallet({ weeks, spends, bank: { balance: 80, at: "2026-11-09T00:00:00Z" } });
  assert.equal(capped.ceiling, 50);
  assert.equal(capped.available, 50);
  assert.equal(capped.thisWeek, 50);
});

test("dollars are shown plainly", () => {
  assert.equal(fmtUsd(12), "$12");
  assert.equal(fmtUsd(12.5), "$12.50");
  assert.equal(fmtUsd(-3), "−$3");
});
