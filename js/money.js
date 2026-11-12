// Fun money: how the Daily Ledger turns a week of habits into dollars to spend on yourself.
// Pure functions only, so the sums can be checked without a browser.
//
// The $500 a month still lands in the fun-money account by direct deposit. Points don't create money;
// they unlock the right to spend it. A good week (300 points) unlocks a week's share of the deposit.

export const MONEY_DEFAULTS = {
  monthly: 500,        // dollars deposited each month
  goodWeek: 300,       // points in a good week, which unlocks one week's share
  cap: 400,            // most points per week that count toward money
  start: "2026-11-02", // first paid week (a Monday)
  goodWeekBonus: 25,   // most weekly targets met and something ticked on 6+ days
  comebackBonus: 25,   // after a week under comebackBelow, reaching comebackAt
  comebackBelow: 150,
  comebackAt: 250,
  lightFactor: 0.6,    // light week: targets and the good week shrink to 60%
  freezeAfterDays: 9,  // a week is closed for good on the Wednesday after it ends
  holdOver: 100,       // things over $100 wait...
  holdHours: 48,       // ...this long once you decide you want them
  phone: { start: 6, step: 0.5, floor: 4, every: 2, hit: 20, beat: 35 },
};

import { ymd, parse, addDays, mondayOf } from "./dates.js";
export { addDays, mondayOf }; // the Ledger imports these from here
export const round2 = n => Math.round(n * 100) / 100;
export const fmtUsd = n => (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(Math.abs(n) % 1 ? 2 : 0);

export function settingsOf(s) {
  const m = (s && s.money) || {};
  return { ...MONEY_DEFAULTS, ...m, phone: { ...MONEY_DEFAULTS.phone, ...(m.phone || {}) } };
}

/** Dollars per point for a week. A light week pays the same for a smaller good week. */
export function rateFor(cfg, light) {
  const weekly = cfg.monthly * 12 / 52;
  return weekly / (cfg.goodWeek * (light ? cfg.lightFactor : 1));
}

/** Weekly bonus target for a habit, after a light week and rest days. 0 = no target. */
export function targetFor(h, cfg, light, restDays) {
  let t = Number(h.bonusAt) || 0;
  if (!t) return 0;
  if (light) t = Math.ceil(t * cfg.lightFactor);
  if (h.kind !== "weekly") t -= restDays;
  return Math.max(1, t);
}

/**
 * Score one week (Monday `wk`) from the day log.
 * habits: active habits [{id, name, points, kind, bonusAt, bonus, created}]
 * days: { "YYYY-MM-DD": { done: {habitId: truthy}, rest: bool } }
 * meta: this week's doc { light, phone } ; prevPoints: last week's points, or null
 * upTo: last day to count (today), so a week in progress scores what has happened so far.
 */
export function scoreWeek({ habits, days, wk, meta = {}, prevPoints = null, phoneTarget = null, cfg, upTo }) {
  const light = !!meta.light;
  const dates = []; for (let i = 0; i < 7; i++) { const d = addDays(wk, i); if (!upTo || d <= upTo) dates.push(d); }
  const restDays = dates.filter(d => days[d] && days[d].rest).length;
  const lines = [];
  let base = 0, targets = 0, met = 0;
  const counts = {};
  for (const h of habits) {
    const n = dates.filter(d => (!h.created || d >= h.created) && days[d] && days[d].done && days[d].done[h.id]).length;
    counts[h.id] = n;
    base += n * (Number(h.points) || 0);
    const t = targetFor(h, cfg, light, restDays);
    if (t) {
      targets++;
      if (n >= t) { met++; const b = Number(h.bonus) || 0; if (b) lines.push({ habit: h.name, amount: b, why: `${n} of ${t} this week` }); }
    }
  }
  const activeDays = dates.filter(d => days[d] && (days[d].rest || Object.keys(days[d].done || {}).length)).length;
  if (targets && met >= Math.min(3, targets) && activeDays >= 6) lines.push({ habit: "Good week", amount: cfg.goodWeekBonus, why: `${met} targets met` });
  if (meta.phone != null && phoneTarget != null) {
    const p = Number(meta.phone);
    if (p <= phoneTarget - 1) lines.push({ habit: "Phone", amount: cfg.phone.beat, why: `${p} h a day, an hour under ${phoneTarget}` });
    else if (p <= phoneTarget) lines.push({ habit: "Phone", amount: cfg.phone.hit, why: `${p} h a day, under ${phoneTarget}` });
  }
  let points = base + lines.reduce((a, l) => a + l.amount, 0);
  const comebackAt = light ? Math.round(cfg.comebackAt * cfg.lightFactor) : cfg.comebackAt;
  if (prevPoints != null && prevPoints < cfg.comebackBelow && points >= comebackAt) {
    lines.push({ habit: "Comeback", amount: cfg.comebackBonus, why: `back after a ${prevPoints}-point week` });
    points += cfg.comebackBonus;
  }
  const capPts = Math.round(cfg.cap * (light ? cfg.lightFactor : 1));
  const counted = Math.min(points, capPts);
  return { wk, light, points, base, bonuses: lines, counts, capPts, counted, over: points - counted, dollars: round2(counted * rateFor(cfg, light)) };
}

/** Phone targets week by week: start at 6, down half an hour after every two weeks hit, never below 4. */
export function phoneTargets(weeks, cfg) {
  const out = {}; let target = cfg.phone.start, hits = 0;
  for (const w of weeks) {
    out[w.wk] = target;
    if (w.phone == null) continue;
    if (Number(w.phone) <= target) { hits++; if (hits >= cfg.phone.every) { target = Math.max(cfg.phone.floor, round2(target - cfg.phone.step)); hits = 0; } }
  }
  return { byWeek: out, next: target };
}

/**
 * Every paid week from cfg.start to today. Closed weeks use their frozen snapshot, so changing a
 * habit's points later never rewrites dollars already unlocked.
 * weekDocs: { "YYYY-MM-DD": { light, phone, frozen: {points, dollars, ...} } }
 */
export function allWeeks({ habits, days, weekDocs, cfg, today }) {
  const out = []; const thisWk = mondayOf(today);
  const metas = []; for (let wk = cfg.start; wk <= thisWk; wk = addDays(wk, 7)) metas.push({ wk, phone: weekDocs[wk]?.phone ?? null });
  const phone = phoneTargets(metas, cfg);
  let prev = null;
  for (let wk = cfg.start; wk <= thisWk; wk = addDays(wk, 7)) {
    const doc = weekDocs[wk] || {};
    let w;
    if (doc.frozen) w = { ...doc.frozen, wk, closed: true };
    else {
      w = scoreWeek({ habits, days, wk, meta: doc, prevPoints: prev, phoneTarget: phone.byWeek[wk], cfg, upTo: today });
      w.closed = false;
      w.dueToFreeze = today >= addDays(wk, cfg.freezeAfterDays);
    }
    w.current = wk === thisWk;
    w.phoneTarget = phone.byWeek[wk];
    out.push(w); prev = w.points;
  }
  return { weeks: out, phoneNext: phone.next };
}

/** The purse: unlocked dollars less spending, held under the last bank balance typed in. */
export function wallet({ weeks, spends, bank }) {
  const unlocked = round2(weeks.reduce((a, w) => a + (Number(w.dollars) || 0), 0));
  const spent = round2(spends.reduce((a, s) => a + (Number(s.dollars) || 0), 0));
  const free = round2(unlocked - spent);
  let ceiling = null;
  if (bank && bank.balance != null && bank.at) {
    const since = spends.filter(s => String(s.at) > String(bank.at)).reduce((a, s) => a + (Number(s.dollars) || 0), 0);
    ceiling = round2(Number(bank.balance) - since);
  }
  const available = Math.max(0, ceiling == null ? free : Math.min(free, ceiling));
  const thisWeek = weeks.length ? weeks[weeks.length - 1] : null;
  return { unlocked, spent, free, ceiling, available, thisWeek: thisWeek && thisWeek.current ? thisWeek.dollars : 0 };
}

/** Price of the next hour of a time treat (PlayStation, extra TV): the first hour is cheaper. */
export function hourPrice(item, spends, day) {
  const n = spends.filter(s => s.itemId === item.id && String(s.day || String(s.at).slice(0, 10)) === day).length;
  return n === 0 ? Number(item.price) || 0 : Number(item.extraPrice ?? item.price) || 0;
}

/** How many habits are ticked on a day. */
export const ticksOn = dayRec => Object.keys((dayRec && dayRec.done) || {}).length;

/** Whether a gated treat is open. gateAny: N = any N habits ticked today (so a physical rest day
 *  still works); gate: [ids] = those habits ticked. A rest day opens either kind. */
export function gateOpen(item, dayRec) {
  const any = Number(item.gateAny) || 0, list = item.gate || [];
  if (!any && !list.length) return true;
  if (dayRec && dayRec.rest) return true;
  if (any && ticksOn(dayRec) < any) return false;
  return list.every(id => dayRec && dayRec.done && dayRec.done[id]);
}
