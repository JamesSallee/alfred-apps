// The Reading Room's offline copies: each shelf piece's words (and, if wanted, its pictures), kept on this device.
// Nothing goes in the database: a copy is fetched once through the link reader (supabase/functions/reading-peek,
// { copy: true }), cleaned here with an allow-list, and kept in the browser's Cache Storage. The service worker
// (sw.js) hands the cached pictures back when there's no signal. Which pieces to keep is offlinePlan in js/reading.js.
//
// localStorage "alfred:reading:offline"      { <item id>: { ok, at, url, pics: [..], picsTried, chars } }
// localStorage "alfred:reading:offlinePics"  "on" | "off"   (per device: pictures take far more room than words)

import { offlinePlan } from "./reading.js";

export const TEXT_CACHE = "alfred-reading-text";
export const PICS_CACHE = "alfred-reading-pics";
const KEY = "alfred:reading:offline";
const PICS_KEY = "alfred:reading:offlinePics";
const MAX_PICS = 40;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const store = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* full or blocked */ } };
let saved = load();

export const supported = () => typeof caches !== "undefined";
export const savedState = () => saved;
export const picsOn = () => { try { return localStorage.getItem(PICS_KEY) !== "off"; } catch { return true; } };
export const setPics = (on) => { try { localStorage.setItem(PICS_KEY, on ? "on" : "off"); } catch { /* blocked */ } };
const textKey = (id) => new URL(`__reading-copy/${encodeURIComponent(id)}`, location.href).href; // a cache key, never fetched

// ---------- Cleaning: only plain reading tags survive, with only links and pictures as attributes ----------
const DROP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "BUTTON",
  "TEMPLATE", "OBJECT", "EMBED", "SELECT", "DIALOG", "LINK", "META", "INPUT", "TEXTAREA", "VIDEO", "AUDIO", "CANVAS", "MATH", "SOURCE"]);
const KEEP = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "EM", "STRONG", "I",
  "B", "A", "IMG", "FIGURE", "FIGCAPTION", "BR", "HR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "SUP", "SUB", "SMALL",
  "DL", "DT", "DD", "Q", "CITE", "S", "U", "MARK"]);
const BLOCKISH = new Set(["DIV", "SECTION", "MAIN", "ARTICLE"]);

function abs(u, base) {
  try { const x = new URL(String(u || "").trim(), base); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; }
}
function imgSrc(img, base) {
  const set = (img.getAttribute("data-srcset") || img.getAttribute("srcset") || "")
    .split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
  const src = img.getAttribute("src") || "";
  return abs(img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original")
    || (src && !src.startsWith("data:") ? src : "") || set[set.length - 1], base);
}

/** The article as safe reading HTML, plus the pictures it shows. Runs in an inert document: nothing loads or runs. */
export function cleanCopy(html, base) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const pics = [];
  const walk = (el) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) { child.remove(); continue; }
      if (tag === "IMG") {
        const src = imgSrc(child, base);
        if (!src || /\b(pixel|spacer|tracking|beacon)\b/i.test(src)) { child.remove(); continue; }
        const alt = child.getAttribute("alt") || "";
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
        child.setAttribute("src", src); child.setAttribute("alt", alt);
        child.setAttribute("loading", "lazy"); child.setAttribute("referrerpolicy", "no-referrer");
        if (!pics.includes(src)) pics.push(src);
        continue;
      }
      walk(child);
      if (KEEP.has(tag)) {
        const href = tag === "A" ? abs(child.getAttribute("href"), base) : "";
        for (const a of [...child.attributes]) child.removeAttribute(a.name);
        if (href) { child.setAttribute("href", href); child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      } else {
        // Anything else (div, span, picture…) gives up its children; a block keeps them on their own line.
        const frag = doc.createDocumentFragment();
        if (BLOCKISH.has(tag) && [...child.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
          const p = doc.createElement("p"); p.append(...child.childNodes); frag.append(p);
        } else frag.append(...child.childNodes);
        child.replaceWith(frag);
      }
    }
  };
  walk(doc.body);
  doc.body.querySelectorAll("p, li, figcaption, h1, h2, h3, h4, blockquote").forEach((n) => { if (!n.textContent.trim() && !n.querySelector("img")) n.remove(); });
  const words = (doc.body.textContent || "").split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
  return { html: doc.body.innerHTML, pics: pics.slice(0, MAX_PICS), words };
}

// ---------- Keeping and reading copies ----------
export async function readCopy(id) {
  if (!supported() || !saved[id]?.ok) return null;
  try { const r = await (await caches.open(TEXT_CACHE)).match(textKey(id)); return r ? await r.json() : null; } catch { return null; }
}

async function keepPics(srcs) {
  const cache = await caches.open(PICS_CACHE), got = [];
  const queue = [...srcs];
  const worker = async () => {
    for (let src; (src = queue.shift());) {
      try {
        if (await cache.match(src)) { got.push(src); continue; }
        // Other sites' pictures come back sealed ("opaque"): fine for an <img>, which is all they're for.
        const res = await fetch(src, { mode: "no-cors", credentials: "omit", referrerPolicy: "no-referrer" });
        if (res.type === "opaque" || res.ok) { await cache.put(src, res); got.push(src); }
      } catch { /* that one stays online only */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return got;
}

async function dropCopy(id) {
  const s = saved[id];
  delete saved[id]; store(saved);
  if (!supported()) return;
  try {
    await (await caches.open(TEXT_CACHE)).delete(textKey(id));
    const others = new Set(Object.values(saved).flatMap((x) => x.pics || []));
    const pc = await caches.open(PICS_CACHE);
    await Promise.all((s?.pics || []).filter((p) => !others.has(p)).map((p) => pc.delete(p)));
  } catch { /* nothing to tidy */ }
}

/** Fetch and keep one piece. Returns false if the link reader couldn't be reached (try again later). */
async function saveCopy(it, look) {
  const data = await look(it.url);
  if (!data) return false;
  const at = new Date().toISOString();
  const clean = data.html ? cleanCopy(data.html, data.base || it.url) : null;
  if (!clean || clean.words < 200) { saved[it.id] = { ok: false, at, url: it.url }; store(saved); return true; }
  await (await caches.open(TEXT_CACHE)).put(textKey(it.id), new Response(JSON.stringify({
    title: it.title, site: it.site, url: it.url, html: clean.html, at,
  }), { headers: { "Content-Type": "application/json" } }));
  const pics = picsOn() ? await keepPics(clean.pics) : [];
  saved[it.id] = { ok: true, at, url: it.url, pics, picsTried: picsOn(), chars: clean.html.length };
  store(saved);
  return true;
}

let running = null;
/**
 * Bring this device's copies up to date with the shelf, one piece at a time.
 * look(url) -> { html, base } | null; onStep({ done, total }) after each piece.
 */
export function syncCopies(items, look, { force = false, atticDays, onStep = () => {} } = {}) {
  if (!supported()) return Promise.resolve({ done: 0, total: 0 });
  if (running && !force) return running;
  const go = async () => {
    const plan = offlinePlan(items, saved, Date.now(), { force, pics: picsOn(), atticDays });
    for (const id of plan.drop) await dropCopy(id);
    const byId = new Map(items.map((it) => [it.id, it]));
    let done = 0;
    for (const id of plan.fetch) {
      if (!navigator.onLine) break;
      const ok = await saveCopy(byId.get(id), look).catch(() => false);
      if (!ok) break; // the link reader is unreachable: stop rather than hammer it
      onStep({ done: ++done, total: plan.fetch.length });
    }
    return { done, total: plan.fetch.length };
  };
  const p = (running || Promise.resolve()).then(go, go).finally(() => { if (running === p) running = null; });
  running = p;
  return p;
}

/** Ready / online-only counts for the given shelf pieces. */
export function tally(items) {
  let ready = 0, online = 0;
  for (const it of items) { const s = saved[it.id]; if (s?.ok && s.url === it.url) ready++; else if (s && !s.ok) online++; }
  return { ready, online, waiting: items.length - ready - online };
}
