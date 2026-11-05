// The Training Room's only route to Peloton. Peloton has no public API; this uses the unofficial one
// (the same one the Peloton website uses), so it may break without warning.
//
// Step 1 of the build: a probe, to find out whether the API gives us what the page needs
// (recent classes, and each strength class's list of moves with their times).
//
// POST { action: "probe" } with the signed-in user's token (supabase.functions.invoke does this).
//   -> a summary of the last 10 workouts, the moves in each strength class, and a map of where
//      weight-like fields appear in the class data. The summary is also saved to app_data
//      ("training" / "peloton/probe") so Alfred can read it back.
//
// Secrets (Supabase -> Edge Functions -> Secrets): PELOTON_USERNAME, PELOTON_PASSWORD.
// The password never leaves this function: it is not logged, returned or stored.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const API = "https://api.onepeloton.com";
const TOKEN_URL = "https://auth.onepeloton.com/oauth/token";
// The Peloton web app's public client id (the same one the open-source pylotoncycle library uses).
const CLIENT_ID = "mgsmWCD0A8Qn6uz6mmqI6qeBNHH9IPwS";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new HttpError(401, "Please sign in first.");
    // Private to the owner: a Larder household member is signed in too, but must not reach this.
    const { data: memberships, error: memErr } = await userClient
      .from("household_members").select("app").eq("member_id", user.id).limit(1);
    if (memErr) throw memErr;
    if (memberships?.length) throw new HttpError(403, "The Training Room is private to its owner.");

    const body = await req.json().catch(() => ({}));
    if (body.action !== "probe") throw new HttpError(400, "Unknown action.");

    const result = await probe();
    const { error: saveErr } = await userClient.from("app_data").upsert({
      user_id: user.id, app: "training", key: "peloton/probe", value: result, deleted: false,
    });
    return json({ ...result, saved: !saveErr, save_error: saveErr?.message });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});

// ---------- Peloton ----------

async function login(): Promise<string> {
  const username = Deno.env.get("PELOTON_USERNAME");
  const password = Deno.env.get("PELOTON_PASSWORD");
  if (!username || !password) throw new HttpError(500, "Add PELOTON_USERNAME and PELOTON_PASSWORD as Supabase secrets first.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "manual",
    body: JSON.stringify({ grant_type: "password", client_id: CLIENT_ID, scope: "openid", username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // Auth0's own error text (e.g. "Wrong email or password."), never the request.
    const why = data.error_description || data.error || `HTTP ${res.status}`;
    throw new HttpError(502, `Peloton login failed: ${why}`);
  }
  return data.access_token;
}

async function get(token: string, path: string) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}`, "Peloton-Platform": "web" },
  });
  if (!res.ok) throw new HttpError(502, `Peloton ${path.split("?")[0]} returned HTTP ${res.status}`);
  return res.json();
}

async function probe() {
  const steps: Record<string, string> = {};
  const token = await login();
  steps.login = "ok";

  const me = await get(token, "/api/me");
  steps.me = "ok";

  const list = await get(token, `/api/user/${me.id}/workouts?joins=ride,ride.instructor&limit=10&page=0&sort_by=-created`);
  steps.workouts = `ok (${list.data?.length ?? 0})`;

  const workouts = [];
  let sampleShape: unknown = null;
  for (const w of list.data || []) {
    const ride = w.ride || {};
    const item: Record<string, unknown> = {
      date: w.start_time ? new Date(w.start_time * 1000).toISOString() : null,
      discipline: w.fitness_discipline,
      title: ride.title,
      instructor: ride.instructor?.name,
      class_minutes: ride.duration ? Math.round(ride.duration / 60) : null,
      worked_minutes: w.end_time && w.start_time ? Math.round((w.end_time - w.start_time) / 60) : null,
      tier_words_in_description: tierWords(ride.description),
    };
    // Only strength classes need their move list; skip "just ride" sessions with no class.
    if (w.fitness_discipline === "strength" && ride.id && ride.id !== "00000000000000000000000000000000") {
      try {
        const details = await get(token, `/api/ride/${ride.id}/details`);
        item.moves = moves(details);
        item.weight_fields = weightPaths(details);
        if (!sampleShape) sampleShape = shape(details.segments ?? details);
      } catch (e) {
        item.details_error = e instanceof Error ? e.message : String(e);
      }
    }
    workouts.push(item);
  }
  steps.details = "ok";

  return { ran_at: new Date().toISOString(), steps, workouts, sample_segments_shape: sampleShape };
}

// ---------- reading the class data without assuming its exact layout ----------

type Move = { name: string; seconds: number | null; offset: number | null; extra?: Record<string, unknown> };

/** Every movement in the class, with the time of the block it sits in. Walks the whole tree,
 *  because the exact layout is undocumented. */
function moves(details: unknown): Move[] {
  const out: Move[] = [];
  const walk = (node: unknown, ctx: { seconds: number | null; offset: number | null }) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, ctx)); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const here = {
      seconds: typeof o.length === "number" ? o.length : ctx.seconds,
      offset: typeof o.offset === "number" ? o.offset : ctx.offset,
    };
    if (Array.isArray(o.movements)) {
      for (const m of o.movements as Record<string, unknown>[]) {
        if (!m || typeof m.name !== "string") continue;
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(m)) {
          if (/weight|rep|load|intens|level/i.test(k)) extra[k] = v;
        }
        out.push({ name: m.name, seconds: here.seconds, offset: here.offset, ...(Object.keys(extra).length ? { extra } : {}) });
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "movements") walk(v, here);
  };
  walk(details, { seconds: null, offset: null });
  return out;
}

/** Paths to any field whose name or text mentions weights, so we can see if tiers are in the data. */
function weightPaths(details: unknown): string[] {
  const hits = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (hits.size >= 25) return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i < 1 ? i : "*"}]`)); return; }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (/weight|dumbbell/i.test(k)) hits.add(`${p} = ${JSON.stringify(v)?.slice(0, 80)}`);
        walk(v, p);
      }
    } else if (typeof node === "string" && /\b(light|medium|heavy)\b/i.test(node) && /weight|dumbbell/i.test(node)) {
      hits.add(`${path} ~ "${node.slice(0, 80)}"`);
    }
  };
  walk(details, "");
  return [...hits];
}

function tierWords(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set((text.match(/\b(light|medium|heavy)\b/gi) || []).map((w) => w.toLowerCase()))];
}

/** The layout of the data (keys and types, one example per array), with no values. */
function shape(node: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(node)) return node.length ? [shape(node[0], depth + 1)] : [];
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return typeof node;
}
