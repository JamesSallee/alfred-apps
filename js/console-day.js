// The console's day (James, 28 Nov 2026): the pieces of the redesigned console that are rules rather than layout,
// kept pure so they can be checked without a browser.
//   • Outside: which calendar blocks happen outdoors, what the forecast says for each, and what to wear.
//   • Coming up: the next trip, tomorrow's first block, the next Writing Desk date, errands due soon.
//   • Habits that only make sense in the evening ("In bed by 11") stay off the console, which is a daytime screen.

import { cleanTitle } from "./calendar.js";
import { addDays } from "./dates.js";

/** Evening-only habits: off the console (they still count towards the aquarium). A habit can also say when: "evening". */
export const isEveningHabit = (h) => h?.when === "evening" || /\b(bed|bedtime|evening|tonight|night)\b/i.test(h?.name || "");

/** Blocks that happen outdoors, by the words in the title. */
const OUTDOOR = /\b(walk|walks|hike|run|jog|yard|garden|gardening|winteri[sz]e[rd]?|rake|raking|leaves|mow|mowing|gutters?|shovel|snow|outside|outdoors?|car wash|wash the car|bins|pick-?up)\b/i;
export const isOutdoor = (title) => {
  const t = cleanTitle(title).display;
  return OUTDOOR.test(t) && !/\b(treadmill|peloton|indoors?)\b/i.test(t);
};

/** Open-Meteo's weather codes in plain words. */
export const sky = (c) => c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle"
  : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c <= 86 ? "Snow showers" : "Thunderstorms";

/**
 * The forecast at a moment: { temp, rain, code } from an hourly Open-Meteo block ({ time: ["2026-11-28T09:00", ...],
 * temperature_2m, precipitation_probability, weather_code }), using the hour the moment falls in. Times are local.
 */
export function hourAt(hourly, localIso) {
  if (!hourly?.time?.length || !localIso) return null;
  const key = localIso.slice(0, 13) + ":00", i = hourly.time.indexOf(key);
  if (i < 0) return null;
  return { temp: Math.round(hourly.temperature_2m[i]), rain: hourly.precipitation_probability?.[i] ?? 0, code: hourly.weather_code?.[i] ?? 0 };
}

/** A local "YYYY-MM-DDTHH:MM" for a Date, as Open-Meteo's hourly times are written. */
export const localIso = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * One line about the weather for an outdoor block: { text, warn, better }.
 * better: a drier hour the same day (a Date), before dark and not already past, when rain looks likely. A suggestion only.
 */
export function blockWeather({ start, hourly, sunset, now }) {
  const at = hourAt(hourly, localIso(start));
  if (!at) return null;
  const dark = sunset && start >= sunset;
  let text = at.rain >= 60 ? `Rain likely (${at.rain}%)` : at.rain >= 30 ? `Chance of rain (${at.rain}%)` : "Dry";
  if (dark) text += ", after dark";
  let better = null;
  if (at.rain >= 50) {
    // The nearest hour, either side, that's dry enough, still to come and before dark.
    let best = null;
    for (let h = 0; h < 24; h++) {
      const d = new Date(start); d.setHours(h, 0, 0, 0);
      if (d < now || (sunset && d >= sunset)) continue;
      const w = hourAt(hourly, localIso(d));
      if (!w || w.rain >= 30) continue;
      if (!best || Math.abs(d - start) < Math.abs(best - start)) best = d;
    }
    better = best;
  }
  return { ...at, text, warn: at.rain >= 50 || !!dark, better };
}

/**
 * What to wear: Alfred's outfit from the Wardrobe when one was picked today, otherwise a plain rule from the
 * temperature and rain, naming pieces he owns. pieces: Wardrobe pieces [{ name, category, ... }].
 * Returns { lead, pieces: [names] }.
 */
export function whatToWear({ outfit, pieces = [], temp, rain = 0 }) {
  const byId = Object.fromEntries(pieces.map((p) => [p.id, p]));
  const top = outfit?.outfits?.[0];
  const picked = (top?.piece_ids || []).map((id) => byId[id]?.name).filter(Boolean);
  if (picked.length) return { lead: top.name ? `Today's outfit: ${top.name}` : "Today's outfit", pieces: picked };
  if (temp == null) return null;
  const live = pieces.filter((p) => p.name && !p.gone && !p.retired && p.status !== "Gone");
  const cat = (re) => live.filter((p) => re.test(p.category || ""));
  const wet = (list) => list.find((p) => /waxed|rain|parka|shell|wax/i.test(p.name)) || list[0];
  const out = [];
  let lead;
  if (temp < 36) { lead = "Coat weather"; const c = wet(cat(/coat/i)) || wet(cat(/jacket/i)); if (c) out.push(c.name); }
  else if (temp < 52) { lead = "A jacket"; const j = rain >= 40 ? wet(cat(/jacket/i)) || wet(cat(/coat/i)) : cat(/jacket/i)[0] || cat(/coat/i)[0]; if (j) out.push(j.name); }
  else if (temp < 64) { lead = "A warm layer"; const k = cat(/knit|sweat|jumper/i)[0]; if (k) out.push(k.name); }
  else lead = "No layer needed";
  if (rain >= 40) { const b = cat(/shoe|boot/i).find((p) => /boot/i.test(p.name)); if (b) out.push(b.name); }
  return { lead, pieces: out };
}

/** The flight or trip coming up: the first own event in `days` (sorted day docs) whose title is a flight or trip. */
const TRIP = /^(flight|fly|flying|✈|trip)\b|\bflight to\b|\btrip to\b/i;
export function nextTrip(dayDocs, now) {
  const all = dayDocs.flatMap((d) => (d.events || []).map((e) => ({ ...e, day: d.day })));
  const at = (e) => new Date(e.start).getTime();
  const flights = all.filter((e) => TRIP.test(cleanTitle(e.title).display) && at(e) >= now.getTime() - 3600e3).sort((a, b) => at(a) - at(b));
  if (!flights.length) return null;
  const go = flights[0];
  const where = cleanTitle(go.title).display.replace(/^(flight|fly|flying|trip)\s*(to)?\s*/i, "").replace(/^✈\s*/, "").trim() || cleanTitle(go.title).display;
  const leave = all.find((e) => e.day === go.day && /^leave for\b/i.test(cleanTitle(e.title).display) && at(e) <= at(go));
  const back = flights.slice(1).find((e) => e.day > go.day);
  return { where, day: go.day, start: go.start, leave: leave ? { title: cleanTitle(leave.title).display, start: leave.start } : null, back: back ? back.day : null };
}

/** "Today", "Tomorrow" or "in 5 days" from one YYYY-MM-DD to another. */
export const daysAway = (from, to) => {
  const n = Math.round((new Date(to + "T12:00") - new Date(from + "T12:00")) / 864e5);
  return n <= 0 ? "Today" : n === 1 ? "Tomorrow" : `${n} days`;
};

/** The next Writing Desk date after today within `within` days: { day, label, title }. */
const DESK_DATES = [["gather", "Gather"], ["draft", "Draft"], ["due", "Schedule"], ["publish", "Out"]];
export function nextDeskDate(pieces, today, within = 14) {
  const end = addDays(today, within), out = [];
  for (const p of pieces) {
    if (p.track !== "ilkwim" || p.stage === "Out" || p.stage === "Skipped") continue;
    const days = new Set([...(p.gathers || []), p.gather].filter(Boolean));
    for (const d of days) if (d > today && d <= end) out.push({ day: d, label: "Gather", title: p.title });
    for (const [k, label] of DESK_DATES.slice(1)) if (p[k] && p[k] > today && p[k] <= end) out.push({ day: p[k], label, title: p.title });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day))[0] || null;
}
