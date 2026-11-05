// The joins between rooms. Each room keeps its own store; this module reads across them
// so that a Peloton class ticks the Ledger, writing time lands on the Desk, the Shutdown
// sees the week's figures, and the Study can show one live number per door.
// Nothing here owns data of its own except the Training Room's "ticked/<workout id>" marks.

import { openStore, supabase } from "./sync.js";

export const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
export const mondayOf = (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

// ---------- Training ----------

/** Peloton discipline -> the Ledger's workout variant (strength, cardio, yoga) or "other". */
export const KIND = (d) => d === "strength" ? "strength" : ["yoga", "stretching"].includes(d) ? "yoga"
  : ["cycling", "running", "walking", "cardio", "bike_bootcamp", "caesar", "caesar_bootcamp", "rowing"].includes(d) ? "cardio" : "other";
/** Cardio counts only when it's a spin class (older fetches also brought in walks, swims and outdoor rides). */
export const isSpin = (w) => ["cycling", "bike_bootcamp"].includes(w.discipline) && !!w.class_id;
/** Every kept workout, newest first. */
export const workoutsOf = (training) => training.list("workouts/").map((x) => x.value)
  .filter((w) => w?.start && (KIND(w.discipline) !== "cardio" || isSpin(w)))
  .sort((a, b) => b.start.localeCompare(a.start));

/** Every logged lift, oldest first: { date, day, move, tier, lb }. */
export function liftHistory(training) {
  const out = [];
  for (const w of workoutsOf(training)) {
    const log = training.get(`log/${w.id}`);
    if (!log || log.skipped) continue;
    for (const [move, tiers] of Object.entries(log.moves || {})) {
      for (const [tier, v] of Object.entries(tiers)) {
        if (v?.lb != null) out.push({ date: w.start, day: ymd(new Date(w.start)), move, tier, lb: v.lb });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Lifts whose heaviest weight between from and to (inclusive days) beat the last weight before from. */
export function liftsUp(training, from, to) {
  const groups = {};
  liftHistory(training).forEach((h) => (groups[`${h.move}|${h.tier}`] ||= []).push(h));
  const up = [];
  for (const g of Object.values(groups)) {
    const before = g.filter((h) => h.day < from).at(-1);
    const during = g.filter((h) => h.day >= from && h.day <= to);
    if (!before || !during.length) continue;
    const best = Math.max(...during.map((h) => h.lb));
    if (best > before.lb) up.push({ move: g[0].move, tier: g[0].tier, from: before.lb, to: best });
  }
  return up.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.move.localeCompare(b.move));
}

// ---------- Training Room -> Ledger ----------
// A synced class ticks the Ledger's workout habit for its day, once. Each class is then marked
// "ticked/<id>" in the training store, so an untick in the Ledger is never undone by the next sync.
// Strength wins a day with more than one class, then cardio, then yoga; a manual tick is never changed.

const RANK = { strength: 3, cardio: 2, yoga: 1 };
const WINDOW_DAYS = 14;
const fresh = (s) => s.status === "saved" || s.status === "pending"; // pulled from the server this session

/** Tick the Ledger for any new classes. Returns [{ day, kind, title }] for the days it ticked. */
export function tickWorkouts(ledger, training) {
  if (!fresh(ledger) || !fresh(training)) return [];
  const habit = ledger.get("habits/workout");
  if (!habit || habit.active === false) return [];
  const variants = new Set((habit.variants || []).map((v) => v.key));
  const today = ymd(new Date());
  const earliest = [addDays(today, -WINDOW_DAYS), habit.created || ""].sort().at(-1);
  const byDay = {};
  for (const w of workoutsOf(training)) {
    if (training.get(`ticked/${w.id}`)) continue;
    const kind = KIND(w.discipline);
    const day = ymd(new Date(w.start));
    if (!(kind in RANK) || day < earliest || day > today) continue;
    (byDay[day] ||= []).push({ w, kind });
  }
  const ticked = [];
  for (const [day, list] of Object.entries(byDay)) {
    const rec = ledger.get(`days/${day}`) || {};
    const done = rec.done || {};
    if (!done.workout) {
      const best = list.slice().sort((a, b) => RANK[b.kind] - RANK[a.kind] || (b.w.minutes || 0) - (a.w.minutes || 0))[0];
      const val = variants.size ? (variants.has(best.kind) ? best.kind : true) : true;
      ledger.set(`days/${day}`, { ...rec, done: { ...done, workout: val }, rest: !!rec.rest });
      ticked.push({ day, kind: best.kind, title: best.w.title });
    }
    const at = new Date().toISOString();
    list.forEach(({ w }) => training.set(`ticked/${w.id}`, { day, at }));
  }
  return ticked;
}

/** Keep the Ledger in step with the Training Room while a page is open. onTick receives each batch. */
export function linkWorkoutsToLedger(onTick = () => {}) {
  const ledger = openStore("ledger"), training = openStore("training");
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    try { const t = tickWorkouts(ledger, training); if (t.length) onTick(t); } finally { busy = false; }
  };
  ledger.subscribe(run); training.subscribe(run);
  ledger.onStatus(run); training.onStatus(run);
  return { ledger, training };
}

/** Ask Peloton for new classes if the last fetch is over 30 minutes old (used by the Ledger too). */
export async function fetchPelotonIfStale(training = openStore("training")) {
  const s = training.get("sync/last");
  if (training.status === "signed-out" || (s && Date.now() - new Date(s.ran_at).getTime() <= 30 * 60e3)) return null;
  const { data, error } = await supabase.functions.invoke("peloton", { body: { action: "sync" } });
  if (error || !data || data.error) return null;
  await training.sync();
  return data;
}

// ---------- Ledger ----------

export const activeHabits = (ledger) => ledger.list("habits/").map((x) => ({ id: x.key.slice(7), ...x.value }))
  .filter((h) => h.active !== false).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

/** The Ledger between two days (inclusive): per-habit counts, the workout mix, total ticks. */
export function weekTally(ledger, from, to) {
  const habits = activeHabits(ledger);
  const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const count = {}, mix = {};
  let ticks = 0, rest = 0;
  days.forEach((d) => {
    const rec = ledger.get(`days/${d}`) || {};
    if (rec.rest) rest++;
    Object.entries(rec.done || {}).forEach(([id, v]) => {
      count[id] = (count[id] || 0) + 1; ticks++;
      if (id === "workout" && typeof v === "string") mix[v] = (mix[v] || 0) + 1;
    });
  });
  const rows = habits.map((h) => {
    const n = count[h.id] || 0;
    const of = h.kind === "weekly" ? Number(h.weeklyTarget) || 1 : days.filter((d) => !h.created || d >= h.created).length;
    return { id: h.id, name: h.name || "Habit", n, of, weekly: h.kind === "weekly" };
  });
  const wo = habits.find((h) => h.id === "workout" && h.variants);
  const workoutMix = wo ? wo.variants.map((v) => ({ label: v.label, n: mix[v.key] || 0, target: v.target || 1 })) : [];
  return { days: days.length, ticks, rest, rows, workoutMix };
}

// ---------- Writing Desk + Focus Room ----------

const FINISHED = { ilkwim: "Out", fiction: "Done", comedy: "Done" };
export const openIlkwim = (desk) => desk.list("pieces/").map((x) => ({ id: x.key.slice(7), ...x.value }))
  .filter((p) => p.track === "ilkwim" && p.stage !== FINISHED.ilkwim && p.stage !== "Skipped");
/** The next ILKWIM post by publish date: the one writing time goes to unless James picks another. */
export function nextPost(desk) {
  const t = ymd(new Date());
  return openIlkwim(desk).filter((p) => p.publish && p.publish >= t).sort((a, b) => a.publish.localeCompare(b.publish))[0];
}
/** Focus sessions logged against a piece: { minutes, sessions, last }. */
export function writingTime(focus, pieceId) {
  const log = focus.list("log/").map((x) => x.value).filter((e) => e.k === "focus" && e.piece === pieceId);
  return { minutes: log.reduce((a, e) => a + (e.m || 0), 0), sessions: log.length, last: log.reduce((a, e) => Math.max(a, e.t), 0) || null };
}
export const fmtMins = (m) => m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;

// ---------- The Study's doors: one live figure each ----------

const shortDate = (s) => parse(s).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** { ledger, focus, shutdown, larder, desk, training, wardrobe } -> { v, c } (value, caption) or null. */
export function doorFigures(stores) {
  const t = ymd(new Date());
  const out = {};
  const { ledger, focus, shutdown, larder, desk, training, wardrobe } = stores;
  if (ledger) {
    const daily = activeHabits(ledger).filter((h) => h.kind !== "weekly");
    const done = ledger.get(`days/${t}`)?.done || {};
    out.ledger = daily.length ? { v: `${daily.filter((h) => done[h.id]).length}/${daily.length}`, c: "today" } : null;
  }
  if (focus) {
    const t0 = parse(t).getTime();
    const m = focus.list("log/").map((x) => x.value).filter((e) => e.k === "focus" && e.t >= t0).reduce((a, e) => a + (e.m || 0), 0);
    out.focus = { v: m < 60 ? String(m) : fmtMins(m), c: m < 60 ? "min today" : "today" };
  }
  if (shutdown) {
    const last = shutdown.list("shutdowns/").map((x) => x.value).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const isSun = new Date().getDay() === 0;
    out.shutdown = last?.date === t ? { v: "Done", c: "closed tonight" }
      : isSun ? { v: "Tonight", c: last ? `last ${shortDate(last.date)}` : "the first one" }
      : last ? { v: shortDate(last.date), c: "last closed" } : null;
  }
  if (larder) {
    const soon = larder.list("pantry/").filter((x) => x.value.useBy && daysBetween(t, x.value.useBy) <= 3).length;
    const all = larder.list("pantry/").length;
    out.larder = soon ? { v: String(soon), c: "to use soon" } : all ? { v: "Fresh", c: "nothing expiring" } : null;
  }
  if (desk) {
    const p = nextPost(desk);
    const d = p && daysBetween(t, p.publish);
    out.desk = p ? { v: d === 0 ? "Today" : d === 1 ? "Tomorrow" : shortDate(p.publish), c: d > 1 ? `next post, in ${d} days` : "next post" } : null;
  }
  if (training) {
    const from = mondayOf(t);
    const n = new Set(workoutsOf(training).filter((w) => KIND(w.discipline) !== "other").map((w) => ymd(new Date(w.start)))
      .filter((d) => d >= from && d <= t)).size; // days with a class, as the 7-a-week habit counts them
    out.training = { v: `${n}/7`, c: "this week" };
  }
  if (wardrobe) {
    const o = wardrobe.list("occasions/").map((x) => x.value).filter((x) => x.date >= t).sort((a, b) => a.date.localeCompare(b.date))[0];
    const d = o && daysBetween(t, o.date);
    out.wardrobe = o ? { v: d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${d} days`, c: o.kind === "trip" ? "to the trip" : "to the occasion" } : null;
  }
  return out;
}
