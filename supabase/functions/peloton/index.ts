// The Training Room's only route to Peloton. Peloton has no public API; this uses the unofficial one
// (the same one the Peloton website uses), so it may break without warning.
//
// POST { action: "sync" } with the signed-in user's token (supabase.functions.invoke does this).
//   Reads the last 14 days of workouts, and for each one not yet saved: the class plan (every move with its weight tier
//   and time), heart rate if Peloton has it, Peloton's muscle-group scores, and for rides the output and time in each power zone.
//   Each workout is saved to app_data as "training" / "workouts/<id>"; the page reads them from there.
//   -> { added, more, latest, debug }
// POST { action: "probe" } is the original test: the last 10 workouts, saved to "training" / "peloton/probe".
//
// Secrets (Supabase -> Edge Functions -> Secrets): PELOTON_USERNAME, PELOTON_PASSWORD.
// The password never leaves this function: it is not logged, returned or stored.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const API = "https://api.onepeloton.com";
const TOKEN_URL = "https://auth.onepeloton.com/oauth/token";
// The Peloton web app's public client id (the same one the open-source pylotoncycle library uses).
const CLIENT_ID = "mgsmWCD0A8Qn6uz6mmqI6qeBNHH9IPwS";
const NO_CLASS = "00000000000000000000000000000000"; // "just ride" sessions
const WINDOW_DAYS = 14; // how far back a sync looks

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
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: { user } } = await db.auth.getUser();
    if (!user) throw new HttpError(401, "Please sign in first.");
    // Private to the owner: a Larder household member is signed in too, but must not reach this.
    const { data: memberships, error: memErr } = await db
      .from("household_members").select("app").eq("member_id", user.id).limit(1);
    if (memErr) throw memErr;
    if (memberships?.length) throw new HttpError(403, "The Training Room is private to its owner.");

    const body = await req.json().catch(() => ({}));
    if (body.action === "sync") return json(await sync(db, user.id));
    if (body.action === "probe") {
      const result = await probe();
      const { error } = await db.from("app_data").upsert({ user_id: user.id, app: "training", key: "peloton/probe", value: result, deleted: false });
      return json({ ...result, saved: !error, save_error: error?.message });
    }
    throw new HttpError(400, "Unknown action.");
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

// ---------- sync ----------

async function sync(db: SupabaseClient, userId: string) {
  // Only the last two weeks matter: older classes are past remembering the weights for.
  const since = Date.now() / 1000 - WINDOW_DAYS * 86400;
  // Which recent workouts are already saved (with their muscle scores)?
  const { data: rows, error } = await db.from("app_data").select("key, muscles:value->muscles")
    .eq("user_id", userId).eq("app", "training").like("key", "workouts/%");
  if (error) throw error;
  const have = new Set((rows || []).filter((r: any) => r.muscles != null).map((r: any) => r.key.slice("workouts/".length)));

  const token = await login();
  const me = await get(token, "/api/me");

  // Newest first; stop at the first workout older than the window.
  const fresh: any[] = [];
  let done = false;
  for (let page = 0; page < 5 && !done; page++) {
    const list = await get(token, `/api/user/${me.id}/workouts?joins=ride,ride.instructor&limit=20&page=${page}&sort_by=-created`);
    const data = list.data || [];
    for (const w of data) {
      if ((w.start_time ?? 0) < since) { done = true; break; }
      if (w.status === "COMPLETE" && !have.has(w.id)) fresh.push(w);
    }
    if (!data.length || page + 1 >= (list.page_count ?? 1)) break;
  }
  const batch = fresh;
  const more = false;

  const plans = new Map<string, Move[]>(); // class plans, shared when a class is retaken
  const debug: Record<string, unknown> = {};
  const out = [];
  for (const w of batch) {
    const ride = w.ride || {};
    const item: Workout = {
      id: w.id,
      start: w.start_time ? new Date(w.start_time * 1000).toISOString() : null,
      discipline: w.fitness_discipline,
      title: ride.title || (ride.id === NO_CLASS ? "Just ride" : "Workout"),
      instructor: ride.instructor?.name || null,
      class_id: ride.id && ride.id !== NO_CLASS ? ride.id : null,
      class_minutes: ride.duration ? Math.round(ride.duration / 60) : null,
      minutes: w.end_time && w.start_time ? Math.round((w.end_time - w.start_time) / 60) : null,
      moves: null, hr: null, ride: null, muscles: [],
    };
    if (item.discipline === "strength" && item.class_id) {
      try {
        if (!plans.has(item.class_id)) plans.set(item.class_id, moves(await get(token, `/api/ride/${item.class_id}/details`)));
        item.moves = plans.get(item.class_id)!;
      } catch (e) { item.note = errText(e); }
    }
    try {
      const graph = await get(token, `/api/workout/${w.id}/performance_graph?every_n=5`);
      if (!debug.graph_shape) debug.graph_shape = shape(graph, 0, 4);
      item.hr = heartRate(graph);
      item.muscles = muscleScores(graph);
      if (item.discipline === "cycling") {
        const summary = await get(token, `/api/workout/${w.id}`);
        if (!debug.summary_ftp) debug.summary_ftp = summary.ftp_info ?? null;
        item.ride = rideStats(graph, summary);
      }
    } catch (e) { item.note = [item.note, errText(e)].filter(Boolean).join(" · "); }
    out.push(item);
  }

  if (out.length) {
    const { error: saveErr } = await db.from("app_data").upsert(out.map((w) => ({
      user_id: userId, app: "training", key: `workouts/${w.id}`, value: w, deleted: false,
    })));
    if (saveErr) throw saveErr;
  }
  const status = { ran_at: new Date().toISOString(), added: out.length, more, debug };
  await db.from("app_data").upsert({ user_id: userId, app: "training", key: "sync/last", value: status, deleted: false });
  return { added: out.length, more, latest: out[0]?.start ?? null, debug };
}

type Move = { name: string; tier: string; seconds: number; at: number };
type Workout = {
  id: string; start: string | null; discipline: string; title: string; instructor: string | null;
  class_id: string | null; class_minutes: number | null; minutes: number | null;
  moves: Move[] | null; hr: unknown; ride: unknown; muscles: unknown[]; note?: string;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The weighted moves of a strength class, in order: name, tier (light/medium/heavy), seconds, and when
 *  it starts. A pyramid shows up as the same move at more than one tier at the same moment. */
function moves(details: any): Move[] {
  const out: Move[] = [];
  for (const seg of details?.segments?.segment_list || []) {
    for (const sub of seg.subsegments_v2 || []) {
      for (const m of sub.movements || []) {
        const tier = m.weight_level;
        if (!m?.name || !["light", "medium", "heavy"].includes(tier)) continue;
        out.push({ name: m.name, tier, seconds: sub.length ?? 0, at: sub.offset ?? 0 });
      }
    }
  }
  return out;
}

/** Average and peak heart rate, and minutes in each heart-rate zone, when a monitor was connected. */
function heartRate(graph: any) {
  const m = (graph?.metrics || []).find((x: any) => x.slug === "heart_rate");
  if (!m || !m.max_value) return null;
  return {
    avg: Math.round(m.average_value ?? 0) || null,
    max: Math.round(m.max_value),
    zones: Array.isArray(m.zones) ? m.zones.map((z: any) => Math.round((z.duration ?? 0) / 60)) : null,
  };
}

/** Peloton's own score for how much each muscle group worked, e.g. { group: "quads", name: "Quads", score: 41.2 }. */
function muscleScores(graph: any) {
  return (graph?.muscle_group_score || [])
    .filter((m: any) => m?.muscle_group && m.score > 0)
    .map((m: any) => ({ group: m.muscle_group, name: m.display_name || m.muscle_group, score: Math.round(m.score * 10) / 10 }));
}

/** Total output, average watts, and seconds in each of the seven power zones (from the FTP at the time). */
function rideStats(graph: any, summary: any) {
  const out = (graph?.metrics || []).find((x: any) => x.slug === "output");
  const total = (graph?.summaries || []).find((x: any) => x.slug === "total_output");
  const ftp = summary?.ftp_info?.ftp || null;
  const every = graph?.seconds_since_pedaling_start?.length > 1
    ? graph.seconds_since_pedaling_start[1] - graph.seconds_since_pedaling_start[0] : 5;
  let zones: number[] | null = null;
  if (ftp && Array.isArray(out?.values)) {
    const edges = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5]; // Peloton's power zones, as fractions of FTP
    zones = [0, 0, 0, 0, 0, 0, 0];
    for (const v of out.values) {
      const z = edges.findIndex((e) => v / ftp < e);
      zones[z === -1 ? 6 : z] += every;
    }
  }
  return {
    kj: total?.value != null ? Math.round(total.value) : null,
    avg_watts: out?.average_value != null ? Math.round(out.average_value) : null,
    ftp,
    zones,
  };
}

// ---------- the original probe ----------

async function probe() {
  const token = await login();
  const me = await get(token, "/api/me");
  const list = await get(token, `/api/user/${me.id}/workouts?joins=ride,ride.instructor&limit=10&page=0&sort_by=-created`);
  const workouts = [];
  for (const w of list.data || []) {
    const ride = w.ride || {};
    const item: Record<string, unknown> = {
      date: w.start_time ? new Date(w.start_time * 1000).toISOString() : null,
      discipline: w.fitness_discipline, title: ride.title, instructor: ride.instructor?.name,
      class_minutes: ride.duration ? Math.round(ride.duration / 60) : null,
    };
    if (w.fitness_discipline === "strength" && ride.id && ride.id !== NO_CLASS) {
      try { item.moves = moves(await get(token, `/api/ride/${ride.id}/details`)); }
      catch (e) { item.details_error = errText(e); }
    }
    workouts.push(item);
  }
  return { ran_at: new Date().toISOString(), steps: { login: "ok", workouts: `ok (${workouts.length})` }, workouts };
}

/** The layout of some data (keys and types, one example per array), with no values. */
function shape(node: unknown, depth = 0, max = 6): unknown {
  if (depth > max) return "…";
  if (Array.isArray(node)) return node.length ? [shape(node[0], depth + 1, max)] : [];
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, shape(v, depth + 1, max)]));
  }
  return typeof node;
}
