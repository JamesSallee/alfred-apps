// The Reading Room's look at a page: its title and roughly how long it takes to read.
// A web page can't read another site (browsers forbid it), so a link pasted into the room, or shared from the phone,
// comes here once. Nothing is stored here and nothing is sent anywhere else; the page saves what comes back.
//
// POST { url } with the signed-in user's token (supabase.functions.invoke does this).
//   -> { title, words, minutes, recipe, article }
//      minutes is null when the page is behind a paywall or a sign-in.
//      recipe / article: the page says so itself (schema.org markup or og:type), which is how a shared link finds its room.

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

  const { url } = await req.json().catch(() => ({}));
  const u = publicUrl(String(url || ""));
  if (!u) return json({ error: "That isn't a public web address." }, 400);
  try {
    const res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ReadingRoom/1.0)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (!publicUrl(res.url)) return json({ error: "Redirected somewhere private." }, 400);
    if (!/html/i.test(res.headers.get("content-type") || "")) return json({ title: "", words: 0, minutes: null, recipe: false, article: false });
    const html = (await res.text()).slice(0, MAX_BYTES);
    const words = wordsOf(html);
    // A paywall or sign-in page has a few hundred words of chrome; don't pretend that's the article.
    return json({
      title: titleOf(html), words, minutes: words > 300 ? Math.max(1, Math.round(words / WPM)) : null,
      recipe: isRecipe(html), article: isArticle(html),
    });
  } catch {
    return json({ title: "", words: 0, minutes: null, recipe: false, article: false });
  }
});
