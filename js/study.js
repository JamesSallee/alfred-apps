// The Study's own reading of the rooms: today's note and greeting (index.html and console.html),
// and the week's Focus Plan as filed by Alfred (console.html).
// Nothing personal lives here: the note's rules come from the "study" store, the rest from each room's store.

import { ymd, addDays, mondayOf, openTasks } from "./rooms.js";
import { esc } from "./ui.js";

// ---------- Today's note ----------
// Rule fields in study/notes:
//   days: [0-6] weekdays (0 = Sunday) · dom: day of month · publish: "this" | "next"
//   (only in weeks whose Wednesday, this week's or next, is a publish day) · text: may use {shutdown}

function isPublishWed(wed, cfg) {
  if (!cfg || !cfg.from) return false;
  const first = new Date(cfg.from + "T00:00");
  const weeks = Math.round((wed - first) / (7 * 864e5));
  return wed >= first && weeks % (cfg.everyWeeks || 1) === 0;
}

/** The Study's greeting for the hour. */
export function greeting(study, now = new Date()) {
  const N = study.get("notes") || {};
  const name = N.name ? ", " + N.name : "";
  const hr = now.getHours();
  return hr < 5 ? `Still up${name}? Bed by eleven was the agreement.`
    : hr < 12 ? `Good morning${name}. The kettle's on.`
    : hr < 17 ? `Good afternoon${name}. Steady as she goes.`
    : hr < 22 ? `Good evening${name}. Mind the unplanned hour.`
    : `Nearly eleven${name}. The study is closing.`;
}

/** Today's note as HTML list items' contents: the study rules, then lines from the Desk, the Wardrobe and the Errand Book. */
export function todaysNote({ study, desk, wardrobe, todo }, now = new Date()) {
  const N = study.get("notes") || {};
  const day = now.getDay(), date = now.getDate();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wed = new Date(today0); wed.setDate(today0.getDate() + (3 - day));
  const nextWed = new Date(wed); nextWed.setDate(wed.getDate() + 7);
  const pub = { this: isPublishWed(wed, N.publish), next: isPublishWed(nextWed, N.publish) };
  const link = '<a href="shutdown.html">Sunday Shutdown</a>';
  const notes = (N.rules || []).filter((r) =>
    (!r.days || r.days.includes(day)) && (r.dom == null || r.dom === date) && (!r.publish || pub[r.publish]))
    .map((r) => esc(r.text).replace("{shutdown}", link));
  const t = ymd(today0);
  notes.push(...deskNotes(desk, t, day), ...wardrobeNotes(wardrobe, t, day), ...todoNotes(todo, t));
  if (!notes.length) notes.push(esc(N.fallback || (N.rules ? "Nothing pressing today." : "Sign in to see today's note.")));
  return notes;
}

// The Writing Desk adds its own lines: publish day, draft day, and an empty bank (Sundays and Mondays).
function deskNotes(deskStore, t, day) {
  const ps = deskStore.list("pieces/").map((x) => x.value);
  const last = { ilkwim: "Out", fiction: "Done", comedy: "Done" };
  const open = ps.filter((p) => p.stage !== last[p.track]);
  const next = open.filter((p) => p.track === "ilkwim" && p.publish && p.publish >= t).sort((a, b) => a.publish.localeCompare(b.publish))[0];
  const desk = '<a href="desk.html">Writing Desk</a>';
  const out = [];
  if (next && next.publish === t) out.push("Publish day: " + esc(next.title) + ". Final pass at the " + desk + ".");
  else if (next && next.draft === t) out.push("Draft day: " + esc(next.title) + ". The link's on the " + desk + ".");
  if ((day === 0 || day === 1) && ps.length && !open.some((p) => p.banked)) out.push("The bank is empty. One finished post in reserve, when you can.");
  return out;
}

// The Wardrobe adds a line when an occasion is close, the tailor is ready, or it's time to measure.
function wardrobeNotes(wardrobeStore, t, day) {
  const days = (s) => Math.round((new Date(s + "T12:00") - new Date(t + "T12:00")) / 864e5);
  const w = '<a href="wardrobe.html">Wardrobe</a>';
  const out = [];
  const occ = wardrobeStore.list("occasions/").map((x) => x.value).filter((o) => o.date >= t && days(o.date) <= 3).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (occ) out.push((occ.kind === "trip" ? "A trip" : esc(occ.level) + " occasion") + (days(occ.date) === 0 ? " today" : days(occ.date) === 1 ? " tomorrow" : " in " + days(occ.date) + " days") + (occ.plan ? ". The outfit's in the " : ". Plan it in the ") + w + ".");
  if (wardrobeStore.list("tailoring/").some((x) => x.value.status === "At the tailor" && x.value.ready && x.value.ready <= t)) out.push("The tailor should have your things ready. See the " + w + ".");
  const ms = wardrobeStore.list("measures/").map((x) => x.key.slice(9)).sort();
  const every = (wardrobeStore.get("settings") || {}).remeasureDays || 30;
  if (ms.length && days(ms.at(-1)) <= -every && day === 0) out.push("Time for the tape measure. Log it in the " + w + ".");
  return out;
}

// The Errand Book adds a line for anything overdue, or booked for today.
function todoNotes(todoStore, t) {
  const open = openTasks(todoStore, t);
  const b = '<a href="todo.html">Errand Book</a>';
  const out = [];
  const late = open.filter((x) => x.due && x.due < t);
  if (late.length) out.push((late.length === 1 ? esc(late[0].title) + " is" : late.length + " things are") + " overdue. See the " + b + ".");
  const booked = open.filter((x) => x.booked?.start && x.booked.start.slice(0, 10) === t)
    .sort((a, b2) => a.booked.start.localeCompare(b2.booked.start))[0];
  if (booked) out.push("Booked for today: " + esc(booked.title) + " at " + new Date(booked.booked.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + ".");
  return out;
}

// ---------- The Focus Plan ----------
// Alfred files each week's plan at shutdown/plans/<Monday>: { week, focusPlan, plannedAt, afterHours, by, blocks? }.
// blocks: [{ day: "YYYY-MM-DD", id, start: "HH:MM", end: "HH:MM", overflow }], 24-hour times. Older filings have
// only the text, whose lines read "Mon W2 · 9:00–9:45 · overflow" with no am/pm: 1 to 6 o'clock is the afternoon.

const DOW = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
const hhmm = (s) => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(s).trim());
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0), ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12; else if (ap === "am" && h === 12) h = 0; else if (!ap && h >= 1 && h <= 6) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

/** Read a Focus Plan's text: { blocks, hardStops: { "YYYY-MM-DD": "HH:MM" } }. */
export function parseFocusPlan(text, monday) {
  const blocks = [], hardStops = {};
  let constraints = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^personal constraints/i.test(line)) { constraints = true; continue; }
    if (constraints) {
      const hs = /^hard stop:\s*(.+)$/i.exec(line);
      if (hs) for (const part of hs[1].split(",")) {
        const m = /([\d:]+\s*(?:am|pm)?)\s+on\s+(\w{3})/i.exec(part);
        if (m && DOW[m[2].toLowerCase()] != null) hardStops[addDays(monday, DOW[m[2].toLowerCase()])] = hhmm(m[1]);
      }
      continue;
    }
    const m = /^(\w{3})\s+(.+?)\s+·\s+([\d:]+\s*(?:am|pm)?)\s*[–-]\s*([\d:]+\s*(?:am|pm)?)(\s+·\s+overflow)?\s*$/i.exec(line);
    if (!m || DOW[m[1].toLowerCase()] == null) continue;
    const start = hhmm(m[3]), end = hhmm(m[4]);
    if (start && end) blocks.push({ day: addDays(monday, DOW[m[1].toLowerCase()]), id: m[2], start, end, overflow: !!m[5] });
  }
  return { blocks, hardStops };
}

/** This week's plan from the shutdown store: { blocks, hardStops }, empty when nothing is filed. */
export function weekPlan(shutdown, now = new Date()) {
  const monday = mondayOf(ymd(now));
  const rec = shutdown.get("plans/" + monday);
  if (!rec) return { blocks: [], hardStops: {} };
  const parsed = parseFocusPlan(rec.focusPlan, monday);
  const blocks = Array.isArray(rec.blocks) && rec.blocks.length ? rec.blocks : parsed.blocks;
  return { blocks: blocks.slice().sort((a, b) => (a.day + a.start).localeCompare(b.day + b.start)), hardStops: parsed.hardStops };
}

/** Minutes from midnight for "HH:MM". */
export const mins = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
