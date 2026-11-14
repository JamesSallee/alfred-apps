// The Reading Room's look at a page: its title and roughly how long it takes to read.
// A web page can't read another site (browsers forbid it), so a link pasted into the room, or shared from the phone,
// comes here once. Nothing is stored here and nothing is sent anywhere else; the page saves what comes back.
//
// POST { url } with the signed-in user's token (supabase.functions.invoke does this).
//   -> { title, words, minutes, recipe, article, image, price }
//      minutes is null when the page is behind a paywall or a sign-in.
//      recipe / article: the page says so itself (schema.org markup or og:type), which is how a shared link finds its room.
//      image: the page's own preview picture (og:image), for the Wants & gifts drawer; "" if none.
//      price: what a shop page says it costs (product meta or schema.org Offer), e.g. "$450"; "" if it doesn't say.
// POST { url, copy: true } -> the same, plus { html, base }: the article's part of the page, for reading offline.
//      html is "" when there's no real article (a paywall, a sign-in, a shop). The page cleans it again with an
//      allow-list before showing it (reading.html, cleanCopy), so nothing here has to be trusted.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const WPM = 230;
const MAX_BYTES = 3_000_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Only public web addresses: never this server's own network.
function publicUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":")) return null;
  return u;
}

const decode = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

function titleOf(html: string): string {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  const t = og?.[1] || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  return decode(t.replace(/\s+/g, " ").trim()).slice(0, 200);
}

function wordsOf(html: string): number {
  const body = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] || /<main[\s\S]*?<\/main>/i.exec(html)?.[0] || html;
  const text = body
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decode(text).split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
}

// The article's part of the page, with the obvious furniture taken out: the biggest of <article>, <main> or <body>
// that has real words in it. Comments, scripts and the like go here; the page's allow-list does the rest.
const MAX_COPY = 1_500_000;
function copyOf(html: string): string {
  const bits = [
    ...[...html.matchAll(/<article[\s\S]*?<\/article>/gi)].map((m) => m[0]),
    /<main[\s\S]*?<\/main>/i.exec(html)?.[0] || "",
    /<body[\s\S]*?<\/body>/i.exec(html)?.[0] || html,
  ].filter(Boolean);
  const scored = bits.map((b, i) => ({ b, w: wordsOf(b), body: i === bits.length - 1 }));
  const best = scored.filter((x) => !x.body && x.w > 300).sort((a, z) => z.w - a.w)[0] || scored[scored.length - 1];
  if (best.w <= 300) return "";
  return best.b
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button|template|object|embed|select|dialog)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|link|meta|input|iframe)\b[^>]*>/gi, "")
    .slice(0, MAX_COPY);
}

// A <meta> tag's content by property or name, whichever order the attributes come in.
function meta(html: string, key: string): string {
  const k = key.replace(/[.:]/g, "\\$&");
  const m = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']+)["']`, "i").exec(html)
    || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${k}["']`, "i").exec(html);
  return m ? decode(m[1].trim()) : "";
}

function imageOf(html: string, base: string): string {
  const raw = meta(html, "og:image") || meta(html, "og:image:url") || meta(html, "twitter:image");
  if (!raw) return "";
  try {
    const u = new URL(raw, base);
    return u.protocol === "https:" && publicUrl(u.href) ? u.href.slice(0, 1000) : "";
  } catch { return ""; }
}

const SYMBOL: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AUD: "A$", JPY: "¥" };
function priceOf(html: string): string {
  let amount = meta(html, "product:price:amount") || meta(html, "og:price:amount");
  let cur = meta(html, "product:price:currency") || meta(html, "og:price:currency");
  if (!amount) {
    for (const b of ldBlocks(html)) {
      const m = /"price"\s*:\s*"?([\d.,]+)"?/.exec(b);
      if (m) { amount = m[1]; cur = /"priceCurrency"\s*:\s*"([A-Z]{3})"/.exec(b)?.[1] || ""; break; }
    }
  }
  const n = Number(String(amount).replace(/,/g, ""));
  if (!n || !isFinite(n)) return "";
  const shown = n % 1 ? n.toFixed(2) : n.toLocaleString("en-US");
  cur = cur.toUpperCase();
  return SYMBOL[cur] ? SYMBOL[cur] + shown : cur ? `${shown} ${cur}` : shown;
}

// Pages describe themselves for search engines: JSON-LD ("@type": "Recipe"), microdata, or og:type.
const ldBlocks = (html: string) => [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const ldHas = (html: string, types: string) => ldBlocks(html).some((b) => new RegExp(`"@type"\\s*:\\s*(\\[[^\\]]*)?"(${types})"`).test(b));
const isRecipe = (html: string) => ldHas(html, "Recipe") || /itemtype=["']https?:\/\/schema\.org\/Recipe["']/i.test(html);
const isArticle = (html: string) =>
  ldHas(html, "Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|OpinionNewsArticle") ||
  /<meta[^>]+property=["']og:type["'][^>]*content=["']article["']/i.test(html) ||
  /<meta[^>]+content=["']article["'][^>]*property=["']og:type["']/i.test(html);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return json({ error: "Please sign in first." }, 401);
  // Only accounts on the allow-list (supabase/allow-list.sql).
  const { data: allowed } = await db.rpc("is_allowed");
  if (!allowed) return json({ error: "This account isn't on the list." }, 403);

  const { url, copy } = await req.json().catch(() => ({}));
  const u = publicUrl(String(url || ""));
  if (!u) return json({ error: "That isn't a public web address." }, 400);
  try {
    const res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReadingRoom/1.0)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (!publicUrl(res.url)) return json({ error: "Redirected somewhere private." }, 400);
    if (!/html/i.test(res.headers.get("content-type") || "")) return json({ title: "", words: 0, minutes: null, recipe: false, article: false, image: "", price: "", html: "" });
    const html = (await res.text()).slice(0, MAX_BYTES);
    const words = wordsOf(html);
    // A paywall or sign-in page has a few hundred words of chrome; don't pretend that's the article.
    return json({
      title: titleOf(html), words, minutes: words > 300 ? Math.max(1, Math.round(words / WPM)) : null,
      recipe: isRecipe(html), article: isArticle(html), image: imageOf(html, res.url), price: priceOf(html),
      ...(copy ? { html: copyOf(html), base: res.url } : {}),
    });
  } catch {
    return json({ title: "", words: 0, minutes: null, recipe: false, article: false, image: "", price: "" });
  }
});
