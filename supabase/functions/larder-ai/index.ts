// The Larder's and the Wardrobe's only route to Claude. The API key lives here, as a Supabase secret, never in the pages.
//
// POST { action, ... } with the signed-in user's token (supabase.functions.invoke does this).
//   suggest      { pantry, soon, pins, moods, note, rules, cookbook }  -> 3 meal ideas
//   web_search   { pantry, soon, pins, moods, note, rules }            -> 3 real recipes with links
//   import_url   { url }                                               -> one recipe (free when the page
//                                                                         publishes schema.org Recipe data)
//   pantry_photo { image, media_type }                                 -> what Claude can see in the fridge
//   recipe_photo { image, media_type }                                 -> a recipe from a cookbook page photo
//   usage        {}                                                    -> this month's spend and the cap
//
// The Wardrobe (private to its owner; see wardrobe.ts) adds the w_* actions: w_tag, w_outfit, w_fit,
// w_gap, w_before_buy, w_style, w_occasion, w_fit_photo, w_look. They share the same budget and usage log.
//
// Every paid call is logged in public.ai_usage and refused once the household's monthly cap is reached.
// Secrets: ANTHROPIC_API_KEY (required), LARDER_MODEL (default claude-sonnet-5-5), LARDER_MONTHLY_CAP_USD (default 10).

import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { wardrobeHandlers } from "./wardrobe.ts";

const MODEL = Deno.env.get("LARDER_MODEL") || "claude-sonnet-5-5";
const CAP_USD = Number(Deno.env.get("LARDER_MONTHLY_CAP_USD") || "10");

// $ per million tokens (input, output). Web searches are $10 per 1,000.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const SEARCH_USD = 0.01;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    // Who is asking, and whose household's budget pays.
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new HttpError(401, "Please sign in first.");
    // Only accounts on the allow-list (supabase/allow-list.sql) may spend the Claude budget.
    const { data: allowed, error: allowErr } = await userClient.rpc("is_allowed");
    if (allowErr) throw allowErr;
    if (!allowed) throw new HttpError(403, "This account isn't on the list.");
    const { data: ownerId, error: ownerErr } = await userClient.rpc("shared_owner", { p_app: "larder" });
    if (ownerErr) throw ownerErr;

    const body = await req.json().catch(() => ({}));
    const spent = await monthSpend(ownerId);
    if (body.action === "usage") return json({ spent, cap: CAP_USD, model: MODEL });

    const handler = HANDLERS[body.action as string];
    if (!handler) throw new HttpError(400, "Unknown action.");
    // The Wardrobe is private: only someone spending their own budget (not a Larder household member) may use it.
    if (String(body.action).startsWith("w_") && ownerId !== user.id) throw new HttpError(403, "The Wardrobe is private to its owner.");
    const guard = () => {
      if (spent >= CAP_USD) {
        throw new HttpError(402, `This month's Claude budget ($${CAP_USD.toFixed(2)}) is spent. It resets on the 1st.`);
      }
    };
    const out = await handler(body, guard);
    let cost = 0;
    if (out.usage) {
      cost = costOf(out.usage);
      await admin.from("ai_usage").insert({
        owner_id: ownerId, user_id: user.id, action: body.action, model: MODEL,
        input_tokens: out.usage.input, output_tokens: out.usage.output, searches: out.usage.searches, cost_usd: cost,
      });
    }
    return json({ ...out.result, cost, spent: spent + cost, cap: CAP_USD });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Claude is busy. Try again in a minute." }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "The Claude key isn't set up correctly." }, 500);
    if (e instanceof Anthropic.APIError) return json({ error: `Claude returned an error (${e.status}).` }, 502);
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
});

// ---------- money ----------

type Usage = { input: number; output: number; searches: number };

async function monthSpend(ownerId: string): Promise<number> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await admin.from("ai_usage").select("cost_usd")
    .eq("owner_id", ownerId).gte("created_at", start.toISOString());
  if (error) throw error;
  return (data || []).reduce((sum, r) => sum + Number(r.cost_usd), 0);
}

function costOf(u: Usage): number {
  const [pin, pout] = PRICES[MODEL] || PRICES["claude-sonnet-5-5"];
  return (u.input * pin + u.output * pout) / 1e6 + u.searches * SEARCH_USD;
}

function usageOf(msg: Anthropic.Beta.BetaMessage): Usage {
  const u = msg.usage;
  return {
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    output: u.output_tokens || 0,
    searches: u.server_tool_use?.web_search_requests || 0,
  };
}

// ---------- Claude ----------

const ALFRED = `You are Alfred, a calm, dry, kindly household butler helping a couple who are not confident cooks plan meals.
Use British spelling. Keep any prose short and warm, with at most a dash of dry wit.
Favour recipes that are simple (few steps, little technique, little washing up) but full of flavour.
Use the household rules you are given; they override these defaults.`;

async function ask(params: {
  content: Anthropic.Beta.BetaContentBlockParam[] | string;
  schema?: Record<string, unknown>;
  tools?: Anthropic.Beta.BetaToolUnion[];
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  system?: string;
}): Promise<{ text: string; usage: Usage }> {
  const msg = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: params.maxTokens ?? 16000,
    system: params.system ?? ALFRED,
    messages: [{ role: "user", content: params.content }],
    output_config: {
      effort: params.effort ?? "low",
      ...(params.schema ? { format: { type: "json_schema", schema: params.schema } } : {}),
    },
    ...(params.tools ? { tools: params.tools } : {}),
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (msg.stop_reason === "refusal") throw new HttpError(422, "Claude declined that one. Try rewording it.");
  if (msg.stop_reason === "max_tokens") throw new HttpError(502, "Claude ran out of room. Try again.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.Beta.BetaTextBlock).text).join("");
  return { text, usage: usageOf(msg) };
}

function parseJson(text: string) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/); // web search answers may wrap the JSON in a sentence
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  throw new HttpError(502, "Claude's answer came back garbled. Try again.");
}

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties: Record<string, unknown>) =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown) => ({ type: "array", items });

const MEAL = obj({
  title: str,
  why: str,                       // one line: why this, tonight
  minutes: int,
  protein_g: int,                 // per serving
  veg_portions: int,              // per serving
  servings: int,
  cookbook_id: { anyOf: [str, { type: "null" }] },
  ingredients: arr(obj({ item: str, have: { type: "boolean" } })),
  steps: arr(str),
});

function context(b: Record<string, unknown>) {
  const list = (x: unknown) => (Array.isArray(x) && x.length ? x.map(String).join(", ") : "none");
  return [
    `Household rules: ${String(b.rules || "Healthy by default, simple to cook, plenty of flavour.")}`,
    `On hand: ${list(b.pantry)}`,
    `Use soon (prioritise these): ${list(b.soon)}`,
    `Pinned wishes: ${list(b.pins)}`,
    `Mood: ${list(b.moods)}`,
    b.note ? `They also said: ${String(b.note).slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");
}

type Result = { result: Record<string, unknown>; usage?: Usage };
// `guard` throws once the month's budget is spent; call it before anything that costs money.
type Handler = (b: Record<string, unknown>, guard: () => void) => Promise<Result>;
const HANDLERS: Record<string, Handler> = {
  ...wardrobeHandlers({ ask, parseJson, photoOf, fail: (status: number, msg: string) => new HttpError(status, msg) }),
  async suggest(b, guard) {
    guard();
    const cookbook = Array.isArray(b.cookbook) ? b.cookbook.slice(0, 60) : [];
    const { text, usage } = await ask({
      content: `${context(b)}

Their saved cookbook (id: title: main ingredients):
${cookbook.map((r: { id: string; title: string; ingredients: string[] }) =>
  `${r.id}: ${r.title}: ${(r.ingredients || []).slice(0, 12).join(", ")}`).join("\n") || "empty"}

Suggest exactly 3 dinners for two. Lean on what is on hand and the use-soon items, and prefer a saved
cookbook recipe when one fits well (set cookbook_id to its id, else null). Mark each ingredient have=true
only if it is on hand; assume salt, pepper, oil and water are always there. Give short, plain steps.
Also write "note": one sentence from Alfred about tonight's choice.`,
      schema: obj({ note: str, meals: arr(MEAL) }),
    });
    return { result: parseJson(text), usage };
  },

  async web_search(b, guard) {
    guard();
    const { text, usage } = await ask({
      content: `${context(b)}

Find 3 real recipes on the web that suit the above. Work in two steps:

1. Plan before searching. Look at everything on hand together and choose 3 different dishes, each
   using as many of the fresh ingredients and proteins as it sensibly can (prioritise "use soon").
   Ignore ready meals, snacks, drinks and condiments when planning; they are not ingredients to cook with.
2. Search once per dish, naming the dish and its main ingredients (e.g. "chicken thigh spinach chickpea
   tray bake recipe"). Never search for a single ingredient on its own. Prefer reputable recipe sites.
   If a search finds nothing suitable, you may try one different wording for that dish.

Only give a url for a recipe page you actually found. If a dish has no good page, still include it,
with "url": "" plus your own short "ingredients" and "steps", so they still get the idea.
Answer with only a JSON object, no other prose:
{"note": "<one sentence from Alfred>", "recipes": [{"title": "", "url": "", "site": "", "minutes": 0,
"protein_g": 0, "why": "<one line: which of their ingredients it uses>", "need": ["<ingredients they would need to buy>"],
"ingredients": ["<only when url is empty>"], "steps": ["<only when url is empty>"]}]}`,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 6 }],
      effort: "medium",
    });
    const out = parseJson(text);
    // Keep found pages, plus Alfred's own version of any dish whose search came up empty.
    out.recipes = (out.recipes || [])
      .map((r: { url?: string }) => ({ ...r, url: /^https?:\/\//.test(r.url || "") ? r.url : "" }))
      .filter((r: { url: string; steps?: unknown[] }) => r.url || (Array.isArray(r.steps) && r.steps.length))
      .slice(0, 3);
    return { result: out, usage };
  },

  // Free when the page publishes Recipe data; only charged when Claude has to read the page.
  async import_url(b, guard) {
    const url = safeUrl(String(b.url || ""));
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AlfredLarder/1.0)", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new HttpError(422, `That page wouldn't open (${res.status}).`);
    const html = (await res.text()).slice(0, 3_000_000);
    const ld = recipeFromJsonLd(html);
    if (ld) return { result: { recipe: { ...ld, url, site: new URL(url).hostname.replace(/^www\./, "") }, via: "page" } };

    const pageText = htmlToText(html).slice(0, 60000);
    if (pageText.length < 200) throw new HttpError(422, "I couldn't find a recipe on that page.");
    guard();
    const { text, usage } = await ask({
      content: `Extract the recipe from this web page. If there is no recipe, return found=false with empty fields.
Estimate protein_g per serving if the page doesn't say. Keep ingredient lines as written.

${pageText}`,
      schema: obj({
        found: { type: "boolean" }, title: str, servings: int, minutes: int, protein_g: int,
        ingredients: arr(str), steps: arr(str),
      }),
    });
    const r = parseJson(text);
    if (!r.found) throw new HttpError(422, "I couldn't find a recipe on that page.");
    delete r.found;
    return { result: { recipe: { ...r, url, site: new URL(url).hostname.replace(/^www\./, "") }, via: "claude" }, usage };
  },

  async pantry_photo(b, guard) {
    guard();
    const { data, media } = photoOf(b);
    const { text, usage } = await ask({
      content: [
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `List the food you can clearly identify in this fridge, freezer or cupboard photo.
Use short everyday names ("Greek yogurt", "Baby spinach"). Skip anything you can't identify.
"where" is fridge, freezer or cupboard. "use_within_days" is a rough guess for fresh produce, dairy
and opened items, or null for things that keep.` },
      ],
      schema: obj({ items: arr(obj({ name: str, where: { type: "string", enum: ["fridge", "freezer", "cupboard"] },
        use_within_days: { anyOf: [int, { type: "null" }] } })) }),
    });
    return { result: parseJson(text), usage };
  },

  // A photo of a cookbook page or a handwritten card.
  async recipe_photo(b, guard) {
    guard();
    const { data, media } = photoOf(b);
    const { text, usage } = await ask({
      content: [
        { type: "image", source: { type: "base64", media_type: media, data } },
        { type: "text", text: `Transcribe the recipe in this photo. If there is no recipe, return found=false with empty fields.
Keep ingredient lines as written. Estimate protein_g per serving and minutes if the page doesn't say.` },
      ],
      schema: obj({
        found: { type: "boolean" }, title: str, servings: int, minutes: int, protein_g: int,
        ingredients: arr(str), steps: arr(str),
      }),
    });
    const r = parseJson(text);
    if (!r.found) throw new HttpError(422, "I couldn't make out a recipe in that photo.");
    delete r.found;
    return { result: { recipe: { ...r, url: null, site: "Photo" } }, usage };
  },
};

function photoOf(b: Record<string, unknown>) {
  const data = String(b.image || "");
  const media = String(b.media_type || "image/jpeg");
  if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) throw new HttpError(400, "Send a JPEG, PNG or WebP.");
  if (!data || data.length > 7_000_000) throw new HttpError(400, "That photo is too large.");
  return { data, media: media as "image/jpeg" | "image/png" | "image/webp" | "image/gif" };
}

// ---------- recipe pages ----------

function safeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new HttpError(400, "That doesn't look like a link."); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "Only web links, please.");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":")) {
    throw new HttpError(400, "Only public recipe sites, please.");
  }
  return u.toString();
}

// Most recipe sites publish schema.org Recipe data for search engines; reading it costs nothing.
function recipeFromJsonLd(html: string) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data: unknown;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const r = findRecipe(data);
    if (!r) continue;
    const ingredients = toArray(r.recipeIngredient).map((x) => clean(String(x))).filter(Boolean);
    if (!ingredients.length) continue;
    return {
      title: clean(String(r.name || "Untitled recipe")),
      servings: parseInt(String(toArray(r.recipeYield)[0] ?? "")) || 2,
      minutes: isoMinutes(r.totalTime) || (isoMinutes(r.prepTime) + isoMinutes(r.cookTime)) || 0,
      protein_g: parseInt(String((r.nutrition as Record<string, unknown> | undefined)?.proteinContent ?? "")) || 0,
      ingredients,
      steps: flattenSteps(r.recipeInstructions),
      image: firstImage(r.image),
    };
  }
  return null;
}

// deno-lint-ignore no-explicit-any
function findRecipe(node: any): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const t = node["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return node;
  return findRecipe(node["@graph"]) || findRecipe(node.mainEntity);
}
const toArray = (x: unknown): unknown[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const clean = (s: string) => htmlToText(s).replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
function isoMinutes(x: unknown): number {
  const m = String(x || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}
// deno-lint-ignore no-explicit-any
function flattenSteps(x: any): string[] {
  return toArray(x).flatMap((s: any) => {
    if (typeof s === "string") return [clean(s)];
    if (s?.["@type"] === "HowToSection") return flattenSteps(s.itemListElement);
    return [clean(String(s?.text || s?.name || ""))];
  }).filter(Boolean);
}
// deno-lint-ignore no-explicit-any
function firstImage(x: any): string | null {
  const i = toArray(x)[0] as any;
  const u = typeof i === "string" ? i : i?.url;
  return typeof u === "string" && /^https:\/\//.test(u) ? u : null;
}
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
