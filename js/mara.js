// Mara's reactivity log, kept in the Ledger under ledger / mara/{id}.
// One entry per moment worth noting: what she met, how close, and how she took it (0–5), or a quiet walk.
// The scale and phases follow her training plan (25 Oct 2026). Pure functions only, so they can be tested.

import { addDays, mondayOf } from "./dates.js";

export const TRIGGERS = [
  { key: "people", label: "Stranger" },
  { key: "dog", label: "Dog" },
  { key: "mail", label: "Post" },
  { key: "other", label: "Other" },
];
export const QUIET = "none"; // a walk with nothing to report

// 0 = noticed, stayed calm · 3 = stared, stiff, barked · 5 = lunged or snapped
export const SCALE = ["Calm", "Noticed", "Stiff", "Barked", "Lunged", "Snapped"];

export const PHASES = [
  { n: 1, label: "Foundation games at home", next: "Games solid at home, 9 times in 10" },
  { n: 2, label: "Far away: open bar, engage-disengage", next: "Eats calmly at that distance, 8 times in 10" },
  { n: 3, label: "Closer: look at that", next: "Glances at the trigger, turns back to you, 8 times in 10" },
  { n: 4, label: "Calm helpers, parallel walks", next: "Normal walks with few reactions" },
  { n: 5, label: "New places, keep paying for calm", next: "Ongoing" },
];

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const isTrigger = (e) => e && e.trigger !== QUIET && Number.isFinite(e.react);

/** A tidy entry from what was tapped, or null if it doesn't make sense. */
export function makeEntry({ day, trigger, react, ft, note }, at = new Date().toISOString()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return null;
  if (trigger === QUIET) return { day, at, trigger: QUIET };
  if (!TRIGGERS.some((t) => t.key === trigger)) return null;
  const r = Math.round(Number(react));
  if (!(r >= 0 && r <= 5)) return null;
  const e = { day, at, trigger, react: r };
  const f = Math.round(Number(ft));
  if (ft !== "" && ft != null && f > 0 && f < 10000) e.ft = f;
  const n = String(note || "").trim().slice(0, 120);
  if (n) e.note = n;
  return e;
}

/** The week starting on `wk` (a Monday): how many moments, quiet walks, and the average and worst per trigger. */
export function weekSummary(entries, wk) {
  const end = addDays(wk, 6);
  const inWeek = entries.filter((e) => e && e.day >= wk && e.day <= end);
  const trig = inWeek.filter(isTrigger);
  const by = {};
  for (const t of TRIGGERS) {
    const rs = trig.filter((e) => e.trigger === t.key).map((e) => e.react);
    if (rs.length) by[t.key] = { n: rs.length, avg: avg(rs), worst: Math.max(...rs) };
  }
  return { n: trig.length, quiet: inWeek.length - trig.length, avg: avg(trig.map((e) => e.react)), by };
}

/** Average reaction for each of the last `weeks` weeks up to the one holding `day`, oldest first. Weeks with nothing logged are null. */
export function trend(entries, day, weeks = 4) {
  const last = mondayOf(day);
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const wk = addDays(last, -7 * i);
    out.push({ wk, avg: weekSummary(entries, wk).avg });
  }
  return out;
}

/** After a big reaction (4 or 5) stress stays up for 1–3 days: the most recent one within the last two days, or null. */
export function recentBigReaction(entries, today) {
  const from = addDays(today, -2);
  const big = entries.filter((e) => isTrigger(e) && e.react >= 4 && e.day >= from && e.day <= today);
  return big.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

export const phaseOf = (settings) => {
  const n = Number(settings && settings.mara && settings.mara.phase) || 1;
  return PHASES.find((p) => p.n === n) || PHASES[0];
};
