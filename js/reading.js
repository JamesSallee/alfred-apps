// The Reading Room's rules, kept apart from the page so they can be tested and so the Study can read them.
//
// Store "reading":
//   items/<id>  { kind: "read" | "curio", title, url, site, minutes (null = not measured yet), drawer (curios),
//                 tags: [..] (e.g. "MoMA", where an imported list came from), note, source: extension|share|paste|import,
//                 savedAt, openedAt, readAt, filedAt (read and kept: never cleared), unfiledAt (taken back out of
//                 Filed away: its 14 days start again from here), errands: [todo task ids],
//                 desk: [Writing Desk piece ids],
//                 Wants & gifts only: price (as written, e.g. "$450"), forWho ("me" or a name), gotAt (bought or given:
//                 out of the drawer, still remembered), image (the product photo the link reader found) }
//   settings    { drawers: [..], archive: "https://archive.ph/newest/", atticDays: 60, clearDays: 14 }
// Read pieces from the shelf are cleared CLEAR_DAYS after they were read, unless filed away.
// Curiosities never clear themselves: they leave only when binned.
// Wants & gifts never drift to the attic (a wish is still a wish in March), and "Got it" moves one out of the drawer.
// Nothing here is a to-do: Alfred reads the room for the Sunday picks and the Study door, and never counts it.

export const WPM = 230;
export const ATTIC_DAYS = 60;
export const CLEAR_DAYS = 14;
export const ARCHIVE = "https://archive.ph/newest/";
export const DRAWERS = ["Art & design", "Music & sound", "Words & ideas", "Tools & code", "Places & outings", "House & making"];

/** The three shelves of the bookcase, by reading time. Unmeasured pieces sit with "An evening" until they are. */
export const SHELVES = [
  { id: "quick", name: "Quick reads", sub: "under 10 min", fits: (m) => m != null && m < 10 },
  { id: "evening", name: "An evening", sub: "10–30 min", fits: (m) => m == null || (m >= 10 && m <= 30) },
  { id: "long", name: "Long reads", sub: "30 min +", fits: (m) => m != null && m > 30 },
];

export const minutesFor = (words) => (words > 0 ? Math.max(1, Math.round(words / WPM)) : null);
export const shelfOf = (m) => SHELVES.find((s) => s.fits(m)).id;

/** The first http(s) link in a piece of text (Android puts the shared link in "text" as often as in "url"). */
export function findUrl(...texts) {
  for (const t of texts) {
    const m = /https?:\/\/[^\s<>"']+/i.exec(t || "");
    if (m) return m[0].replace(/[).,;:!?]+$/, "");
  }
  return "";
}

export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** The archived copy's address: the archive's newest snapshot, or its "archive this page" screen if there is none. */
export const archiveUrl = (url, base = ARCHIVE) => base + url;

const DAY = 864e5;
const last = (it) => Math.max(Date.parse(it.savedAt || 0) || 0, Date.parse(it.openedAt || 0) || 0);

/** The wish-list drawer, whatever James calls it: it takes a price, who it's for and a "Got it" tick. */
export const isWants = (drawer) => /\b(wants?|wish|gifts?)\b/i.test(drawer || "");

/** Where an item lives now: "shelf" (to read), "cabinet" (curiosities), "attic", "read", "filed" (read and kept) or "got". */
export function placeOf(it, now = Date.now(), atticDays = ATTIC_DAYS) {
  if (it.readAt) return it.filedAt ? "filed" : "read";
  if (it.gotAt) return "got";
  if (it.kind === "curio" && isWants(it.drawer)) return "cabinet";
  if (now - last(it) > atticDays * DAY) return "attic";
  return it.kind === "curio" ? "cabinet" : "shelf";
}

/** Whole days left before a read piece is cleared (0 = due now), or null if it never will be. */
export function clearsIn(it, now = Date.now(), clearDays = CLEAR_DAYS) {
  if (!it.readAt || it.filedAt || it.kind === "curio") return null;
  const from = Math.max(Date.parse(it.readAt) || 0, Date.parse(it.unfiledAt || 0) || 0);
  if (!from) return null;
  return Math.max(0, Math.ceil((from + clearDays * DAY - now) / DAY));
}

/**
 * The read pieces due to be cleared, as { id, ...value }. Only shelf pieces that were read more than
 * clearDays ago and weren't filed away; never curiosities, never anything unread.
 * The page only clears once the store has just synced ("saved"): a device working from an old copy
 * mustn't bin a piece that was filed away or put back on another one.
 */
export function dueForClearing(store, now = Date.now(), clearDays = CLEAR_DAYS) {
  if (store.status !== "saved") return [];
  return itemsOf(store).filter((it) => clearsIn(it, now, clearDays) === 0);
}

/** Every item as { id, ...value }, newest first. */
export const itemsOf = (store) => store.list("items/").map((x) => ({ id: x.key.slice(6), ...x.value }))
  .sort((a, b) => last(b) - last(a));

// A first guess at a curiosity's drawer from its words; anything unclear waits in Loose ends.
const HINTS = [
  ["Art & design", /\b(art\b|arts\b|artist|painter|paint|gallery|museum|moma|exhibit|sculpt|photo|design|typeface|font|illustrat|print)/i],
  ["Music & sound", /\b(music|band|album|record|vinyl|song|playlist|spotify|bandcamp|gig|concert|podcast|mic\b|microphone|synth|guitar|piano)/i],
  ["Words & ideas", /\b(book|novel|author|writer|essay|poem|poet|newsletter|substack|idea|philosoph|history)/i],
  ["Tools & code", /\b(app\b|apps\b|tool\b|tools\b|software|code|coding|github|api|ai\b|claude|plugin|extension|javascript|css|html|bootcamp)/i],
  ["Places & outings", /\b(restaurant|cafe|café|bar\b|ramen|pizza|trip|hike|beach|park\b|show\b|shows\b|theatre|theater|museum visit|day out|weekend away|hotel)/i],
  ["House & making", /\b(house|home|garden|diy|wiring|electric|plumb|paint the|repair|fix|build|woodwork|tool kit|furniture)/i],
];
export function suggestDrawer(text, drawers = DRAWERS) {
  for (const [d, re] of HINTS) if (drawers.includes(d) && re.test(text || "")) return d;
  return null;
}

/** The figure on the Study's door. */
export function readingFigure(store, now = Date.now()) {
  const items = itemsOf(store);
  if (!items.length) return null;
  const shelf = items.filter((it) => placeOf(it, now) === "shelf");
  if (shelf.length) return { v: String(shelf.length), c: "to read" };
  const cab = items.filter((it) => placeOf(it, now) === "cabinet");
  return cab.length ? { v: String(cab.length), c: "curiosities" } : null;
}

/** "1 hr 50 min" style totals. */
export function fmtTotal(m) {
  if (!m) return "";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} hr${r ? ` ${r} min` : ""}` : `${r} min`;
}

// ---------- Which room a shared link belongs in ----------
// Recipe sites James is likely to share from, for when a site turns the link-reader away.
const RECIPE_SITES = /(^|\.)(cooking\.nytimes\.com|seriouseats\.com|bonappetit\.com|epicurious\.com|allrecipes\.com|smittenkitchen\.com|bbcgoodfood\.com|food52\.com|budgetbytes\.com|thekitchn\.com|foodnetwork\.com|delish\.com|halfbakedharvest\.com|minimalistbaker\.com|recipetineats\.com|kingarthurbaking\.com|ottolenghi\.co\.uk|nigella\.com|jamieoliver\.com|bbc\.co\.uk\/food)$/i;

/** A recipe by its address alone: a known recipe site, or "/recipe(s)/" in the path. */
export function looksLikeRecipeUrl(url) {
  try {
    const u = new URL(url), host = u.hostname.replace(/^www\./, "");
    return RECIPE_SITES.test(host) || (host === "bbc.co.uk" && u.pathname.startsWith("/food/")) || /\/recipes?\//i.test(u.pathname);
  } catch { return false; }
}

/**
 * Where a shared link goes: "larder" (a recipe, to the cookbook), "shelf" (something to read) or "ask".
 * `look` is what the link-reader said ({ recipe, article, minutes }), or null if it couldn't look.
 */
export function routeFor(url, look) {
  if (look?.recipe || looksLikeRecipeUrl(url)) return "larder";
  if (look?.article || look?.minutes) return "shelf";
  return "ask";
}

// ---------- Offline copies (kept on each device, never in the database: see js/reading-offline.js) ----------
// saved: { <item id>: { ok, at, url, pics: [..], picsTried } }  ok false = "online only" (a paywall or a sign-in).
export const RETRY_DAYS = 7;

/**
 * Which copies to fetch and which to throw away. Every unread shelf piece with a link gets a copy; read, binned
 * or attic ones lose theirs (bringing one back from the attic saves it again). "Online only" pieces are tried again after RETRY_DAYS, or now when packing.
 * force (Pack for the trip) also fetches pictures for copies saved while pictures were off.
 */
export function offlinePlan(items, saved = {}, now = Date.now(), { force = false, pics = true, atticDays = ATTIC_DAYS } = {}) {
  const wanted = items.filter((it) => it.kind === "read" && it.url && placeOf(it, now, atticDays) === "shelf");
  const ids = new Set(wanted.map((it) => it.id));
  const fetch = wanted.filter((it) => {
    const s = saved[it.id];
    if (!s || s.url !== it.url) return true;
    if (!s.ok) return force || now - (Date.parse(s.at) || 0) > RETRY_DAYS * DAY;
    return force && pics && !s.picsTried;
  }).map((it) => it.id);
  const drop = Object.keys(saved).filter((id) => !ids.has(id));
  return { fetch, drop };
}
