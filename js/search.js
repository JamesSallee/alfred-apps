// Searching the Errand Book: every task, open or done, by its title, notes, area and "waiting on".
// Words are matched anywhere, in any order, and all of them must be found; case and accents don't count
// ("cafe" finds "Café"). Pure functions, so the tests can run them without a page.
import { esc } from "./ui.js";

// Lower-case and strip accents, one character at a time, remembering where each folded character came
// from so a match in the folded text can be marked in the original.
function foldMap(s) {
  let out = ""; const from = [];
  let at = 0;
  for (const c of String(s ?? "")) {
    const f = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += f; for (let j = 0; j < f.length; j++) from.push(at);
    at += c.length;
  }
  return { out, from };
}
export const fold = (s) => foldMap(s).out;

// Words split from a query, folded, longest first (so marking "car" inside "carpet" doesn't hide "carpet").
const splitWords = (q) => [...new Set(fold(q).split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);

// Shortcut words filter instead of matching text: "high overdue", "booked december", "waiting".
// A month means the next one of that name (this year's if it hasn't passed) and finds tasks planned for,
// due in, booked in or done in it.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthOf = (w) => { const i = MONTHS.findIndex((m) => w === m || (w.length >= 3 && m.startsWith(w) && (w.length === 3 || w === "sept"))); return i; };
const MONTH_LABEL = (i) => MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1);
const FILTERS = {
  high: ["High priority", (x) => x.priority === "High"],
  low: ["Low priority", (x) => x.priority === "Low"],
  overdue: ["Overdue", (x, t) => x.status !== "done" && !!x.due && x.due < t],
  late: ["Overdue", (x, t) => x.status !== "done" && !!x.due && x.due < t],
  booked: ["Booked", (x) => !!x.booked?.start],
  waiting: ["Waiting on someone", (x) => x.status === "waiting"],
  snoozed: ["Snoozed", (x, t) => x.status !== "done" && x.snoozeUntil > t],
  someday: ["Someday", (x) => x.status !== "done" && !!x.someday],
  open: ["Not done", (x) => x.status !== "done"],
  done: ["Done", (x) => x.status === "done"],
};
export function parseQuery(q, t) {
  const words = [], filters = [];
  for (const w of splitWords(q)) {
    const m = monthOf(w);
    if (m >= 0) {
      const y = +t.slice(0, 4) + (m + 1 < +t.slice(5, 7) ? 1 : 0);
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      const inMonth = (d) => typeof d === "string" && d.slice(0, 7) === key;
      filters.push({ key: "m" + key, label: MONTH_LABEL(m), test: (x) => inMonth(x.planFor) || inMonth(x.due) || inMonth(x.booked?.start) || (x.status === "done" && inMonth(x.doneAt)) });
    } else if (FILTERS[w]) filters.push({ key: FILTERS[w][0], label: FILTERS[w][0], test: FILTERS[w][1] });
    else words.push(w);
  }
  const seen = new Set();
  return { words, filters: filters.filter((f) => !seen.has(f.key) && seen.add(f.key)) };
}
// Just the words that match text, for marking them in the results.
export const queryWords = (q, t = "2000-01-01") => parseQuery(q, t).words;

const FIELDS = ["title", "notes", "area", "waitingOn"];
const hay = (x) => FIELDS.map((f) => fold(x[f] || "")).join("\n");

export const matches = (x, words) => { const h = hay(x); return words.every((w) => h.includes(w)); };

// Open tasks first (the live ones, then snoozed or waiting, then Someday), then done ones, newest first.
// Within a rank, a task whose title holds every word comes before one found only through its notes.
const rank = (x, t) => x.status === "done" ? 3 : x.someday ? 2 : (x.snoozeUntil > t || x.status === "waiting") ? 1 : 0;
export function searchTasks(tasks, q, t) {
  const { words, filters } = parseQuery(q, t);
  if (!words.length && !filters.length) return [];
  const inTitle = (x) => { const h = fold(x.title); return words.every((w) => h.includes(w)) ? 0 : 1; };
  return tasks.filter((x) => matches(x, words) && filters.every((f) => f.test(x, t))).sort((a, b) => rank(a, t) - rank(b, t)
    || (rank(a, t) === 3 ? (b.doneAt || "").localeCompare(a.doneAt || "") : 0)
    || inTitle(a) - inTitle(b)
    || (a.due || "9999").localeCompare(b.due || "9999")
    || (a.title || "").localeCompare(b.title || ""));
}

// Escaped HTML of `text` with each matched word wrapped in <mark>.
export function highlight(text, words) {
  const s = String(text ?? "");
  if (!words?.length || !s) return esc(s);
  const { out, from } = foldMap(s);
  const hit = new Array(s.length).fill(false);
  for (const w of words) {
    for (let i = out.indexOf(w); i !== -1; i = out.indexOf(w, i + 1)) {
      const a = from[i], b = i + w.length < from.length ? from[i + w.length] : s.length;
      for (let k = a; k < b; k++) hit[k] = true;
    }
  }
  let html = "", open = false;
  for (let k = 0; k < s.length; k++) {
    if (hit[k] !== open) { html += hit[k] ? "<mark>" : "</mark>"; open = hit[k]; }
    html += esc(s[k]);
  }
  return html + (open ? "</mark>" : "");
}

// A short piece of the notes around the first match, for a task found through its notes.
export function snippet(notes, words, room = 40) {
  const s = String(notes ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const f = fold(s);
  const at = Math.min(...words.map((w) => f.indexOf(w)).filter((i) => i >= 0));
  if (!isFinite(at)) return "";
  const a = Math.max(0, at - room), b = Math.min(s.length, at + room * 2);
  return (a ? "…" : "") + s.slice(a, b).trim() + (b < s.length ? "…" : "");
}
