// The calendar and the Ledger as one (James, 28 Nov 2026).
// The Google sync function (supabase/functions/alfred-gtasks) copies the primary calendar's events for
// yesterday, today and tomorrow into app "alfred", key "calendar/<YYYY-MM-DD>", every 5 minutes. Only events
// James created himself (Alfred's ◆ blocks are made under his account) are copied; invitations and events
// other people created never are. This module decides which of those are tickable, and what a tick means.
// Pure functions only, so the rules can be checked without a browser.
//
// What counts (agreed 28 Nov):
//   • Alfred's blocks ("◆ …"): always, except "◆ Unplanned" (protected rest, not a job).
//   • James's own events: when the title matches a Ledger habit or an open Errand Book task,
//     or when it starts with "+" (ticking one adds a done task to the Errand Book).
//   • Everything else stays plain calendar. "Not a task" hides an item for good (by its recurring id).

import { addDays } from "./dates.js";

export const JOBS_CAP = 20;            // most job points that count in a week
export const MIN_PER_POINT = 15;       // a job earns about a point per 15 minutes
export const SKIP_TITLES = ["unplanned"]; // Alfred blocks that are never tickable

/** Habit id -> extra words a calendar title may use for it. Each habit's own name and id count too. */
export const ALIASES = {
  write: ["writing"],
  workout: ["peloton", "strength", "cardio", "yoga", "stretch", "easy ride", "ride", "spin"],
  "walk-mara": ["walk mara", "mara walk", "walk the dog"],
  bootcamp: ["coding", "bootcamp", "web developer bootcamp"],
  meditate: ["meditation"],
  journal: ["journal"],
  piano: ["piano practice"],
};
/** Title word -> the workout variant it implies. */
export const WORKOUT_KIND = { strength: "strength", cardio: "cardio", "easy ride": "cardio", ride: "cardio", spin: "cardio", yoga: "yoga", stretch: "yoga" };

/** "◆ Chore · Laundry: dryer swap" -> { text: "laundry: dryer swap", chore: true, plus: false } */
export function cleanTitle(raw) {
  let s = String(raw || "").trim();
  const alfred = s.startsWith("◆");
  s = s.replace(/^◆\s*/, "");
  const plus = !alfred && s.startsWith("+");
  s = s.replace(/^\+\s*/, "");
  const chore = /^chore\s*[·:\-]\s*/i.test(s);
  s = s.replace(/^chore\s*[·:\-]\s*/i, "");
  return { text: s.toLowerCase().replace(/\s+/g, " ").trim(), display: s.trim(), chore, plus, alfred };
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Whether a title starts with a phrase as a whole word ("write: x" and "write" match "write"; "writer" doesn't). */
const startsWord = (text, phrase) => text === phrase || (text.startsWith(phrase) && /^[\s:·\-(,]/.test(text.slice(phrase.length)));

/** Which habit a title names, with a workout variant when the title implies one: { id, variant } or null. */
export function habitFor(text, habits) {
  const t = norm(text);
  let best = null;
  for (const h of habits) {
    const words = [h.name, h.id.replace(/-/g, " "), ...(ALIASES[h.id] || [])].map(norm).filter(Boolean);
    for (const w of words) if (startsWord(t, w) && (!best || w.length > best.len)) best = { id: h.id, len: w.length, word: w };
  }
  if (!best) return null;
  return { id: best.id, variant: best.id === "workout" ? WORKOUT_KIND[best.word] || null : null };
}

const ms = (s) => new Date(s).getTime();
const words = (s) => new Set(norm(s).split(" ").filter((w) => w.length >= 4));
/** Tasks whose booked slot holds this event (Alfred books one slot for a task, or one slot for two tasks, and a long
 *  job like laundry can span several blocks). A slot that merely contains the event must also share a word with it,
 *  so other blocks inside an all-day laundry slot don't count as laundry. */
function tasksBookedFor(ev, text, tasks) {
  if (!ev.start || ev.allDay) return [];
  const a = ms(ev.start), b = ms(ev.end || ev.start), w = words(text);
  return tasks.filter((x) => {
    if (!x.booked || !x.booked.start) return false;
    const s = ms(x.booked.start), e = ms(x.booked.end || x.booked.start);
    if (!(s <= a + 60e3 && b <= e + 60e3)) return false;
    if (Math.abs(s - a) <= 60e3 && Math.abs(e - b) <= 60e3) return true;
    return [...words(x.title)].some((t) => w.has(t));
  });
}
/** Tasks whose title matches the event's (exactly, or one inside the other once both are at least 6 letters). */
function tasksTitled(text, tasks) {
  const t = norm(text);
  if (!t) return [];
  const exact = tasks.filter((x) => norm(x.title) === t);
  if (exact.length) return exact;
  return tasks.filter((x) => { const n = norm(x.title); return n.length >= 6 && t.length >= 6 && (n.includes(t) || t.includes(n)); });
}

/** Minutes between two times, at least 0. */
export const minutesOf = (ev) => (ev.start && ev.end && !ev.allDay ? Math.max(0, Math.round((ms(ev.end) - ms(ev.start)) / 60e3)) : 0);
/** Points a job earns: about one per 15 minutes, at least 1, at most 8. */
export const jobPoints = (minutes) => Math.min(8, Math.max(1, Math.round((Number(minutes) || 0) / MIN_PER_POINT)));

/**
 * The tickable items for one day, in time order.
 * events: [{ id, rid, title, start, end, allDay, alfred }] from calendar/<day>
 * habits: active Ledger habits; tasks: every Errand Book task (done ones too, so a ticked job still shows)
 * hidden: event ids or recurring ids marked "Not a task"; now: Date, to say which blocks have ended
 * Each item: { key, eventId, title, start, end, allDay, ended, source: "alfred"|"own",
 *              kind: "habit"|"task"|"plus"|"block", habit?: {id, variant}, taskIds: [], minutes, points }
 */
export function tickables({ events = [], habits = [], tasks = [], hidden = [], now = new Date() }) {
  const hide = new Set(hidden);
  const out = [];
  for (const ev of events) {
    if (!ev || !ev.id || hide.has(ev.id) || (ev.rid && hide.has(ev.rid))) continue;
    const c = cleanTitle(ev.title);
    const alfred = !!(ev.alfred || c.alfred);
    if (!c.text || (alfred && SKIP_TITLES.includes(norm(c.text)))) continue;
    const minutes = minutesOf(ev);
    const base = { key: ev.rid || ev.id, eventId: ev.id, title: c.display || ev.title, start: ev.start || null, end: ev.end || null,
      allDay: !!ev.allDay, ended: !ev.allDay && !!ev.end && ms(ev.end) <= now.getTime(), source: alfred ? "alfred" : "own", minutes };
    const habit = c.chore ? null : habitFor(c.text, habits);
    if (habit) { out.push({ ...base, kind: "habit", habit, taskIds: [], points: 0 }); continue; }
    // A task ticked from this very event stays linked to it (so it shows ticked, and an untick finds it).
    let hits = tasks.filter((x) => x.calEvent === ev.id);
    if (alfred) hits = [...new Set([...hits, ...tasksBookedFor(ev, c.text, tasks)])];
    // By title, only open tasks: a done one is history, and a repeat's next copy mustn't double up with it.
    if (!hits.length) hits = tasksTitled(c.text, tasks.filter((x) => x.status !== "done"));
    if (hits.length) {
      const size = hits.reduce((a, x) => a + (Number(x.size) || 0), 0);
      out.push({ ...base, kind: "task", taskIds: hits.map((x) => x.id), points: jobPoints(minutes || size) });
      continue;
    }
    if (c.plus) { out.push({ ...base, kind: "plus", taskIds: [], points: jobPoints(minutes || 30) }); continue; }
    if (alfred) out.push({ ...base, kind: "block", taskIds: [], points: 0 });
  }
  // A long job can have several blocks (laundry: load, swap, fold). Each block records which blocks share its
  // tasks, so ticking one block doesn't finish the job; the last block's tick does.
  const blocks = {};
  for (const i of out) for (const id of i.taskIds) (blocks[id] ||= []).push(i.eventId);
  for (const i of out) if (i.kind === "task") i.blocks = Object.fromEntries(i.taskIds.map((id) => [id, blocks[id]]));
  return out.sort((a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1));
}

/** The day doc's jobs map is keyed by the calendar event a job was ticked from. */
export const jobKey = (item) => "e:" + item.eventId;
/** Tasks a tick on this block should finish: those with no other block left unticked today. */
export const tasksToFinish = (item, dayRec = {}) => item.taskIds.filter((id) =>
  (item.blocks?.[id] || [item.eventId]).every((e) => e === item.eventId || (dayRec.jobs || {})["e:" + e]));

/** Habit ids that today's calendar already shows, so the plain list leaves them out. */
export const habitsOnCalendar = (items) => new Set(items.filter((i) => i.kind === "habit").map((i) => i.habit.id));

/** Whether an item is ticked: a habit by the day's done map, a task when all its tasks are done, the rest by outcome. */
export function isTicked(item, dayRec = {}, tasksById = {}) {
  if (item.kind === "habit") return !!(dayRec.done && dayRec.done[item.habit.id]);
  if (item.kind === "task") return !!(dayRec.jobs && dayRec.jobs[jobKey(item)]) || (item.taskIds.length > 0 && item.taskIds.every((id) => tasksById[id]?.status === "done"));
  if (item.kind === "plus") return !!(dayRec.jobs && dayRec.jobs[jobKey(item)]);
  return (dayRec.cal || {})[item.eventId] === "done";
}

/** Items from a day that ended without a tick or an answer ("Later" still counts as no answer): "did this happen?". */
export const unanswered = (items, dayRec = {}, tasksById = {}) =>
  items.filter((i) => i.ended && !isTicked(i, dayRec, tasksById) && !["done", "skip"].includes((dayRec.cal || {})[i.eventId]));

/** Job points on one day (already capped per job), from the day's jobs map. */
export const dayJobPoints = (dayRec) => Object.values((dayRec && dayRec.jobs) || {}).reduce((a, j) => a + (Number(j.pts) || 0), 0);

// ---------- A skipped Write and the Writing Desk ----------

/**
 * A writing block was skipped on `day`. Which Desk date did it carry, and where could it go?
 * pieces: open ILKWIM pieces [{ id, title, publish, gather, draft, due, slips }]
 * Returns null when nothing on the Desk depended on that day, or
 *   { piece, field: "draft"|"gather", from, to } with a proposed new date, or
 *   { piece, field, from, to: null, why: "once"|"no-room" } when it can't (or shouldn't) move.
 * Rules: the date moves to the next day (from `today`, never before it) that still leaves the rhythm room:
 * a gather no later than the draft day, a draft no later than the day it's due in Substack. Each date moves once;
 * a second slip is let go, as Alfred's rules say.
 */
export function deskSlip(pieces, day, today) {
  const order = ["draft", "gather"];
  for (const field of order) {
    const p = pieces.find((x) => x[field] === day && x.publish && x.publish >= day);
    if (!p) continue;
    if ((p.slips || {})[field] >= 1) return { piece: p, field, from: day, to: null, why: "once" };
    const limit = field === "gather" ? p.draft || addDays(p.publish, -2) : p.due || addDays(p.publish, -1);
    const to = addDays(today > day ? today : day, 1);
    return to <= limit ? { piece: p, field, from: day, to } : { piece: p, field, from: day, to: null, why: "no-room" };
  }
  return null;
}
