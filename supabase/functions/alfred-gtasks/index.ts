// Alfred on the wrist, through Google Tasks (no extra apps on the phone or watch).
//
// The Pixel Watch's Google Calendar app shows Google Tasks and has a tile, and Gemini on the watch can add
// to a named Tasks list. This function keeps two Google Tasks lists in step with the rooms:
//   "Errands"  Errand Book tasks due today or this week (to Sunday), plus overdue ones (shown as due today).
//              Tick one on the watch and it's ticked in the Errand Book. Anything added by voice
//              ("add stamps to my Errands list") becomes an Errand Book triage task, and so does anything
//              new in the default "My Tasks" list, where Gemini often files things.
//   "Ideas"    Anything added here ("add ... to my Ideas list") moves to the Writing Desk idea shelf
//              (ILKWIM, stage Idea) and is cleared from Tasks.
//
// GET  ?a=start&t=<watch token>     Sends you to Google to connect (once). Comes back to this function.
// GET  ?code=...&state=...           Google's return trip: stores the refresh token in the vault.
// GET  ?a=status&t=<watch token>     Says whether it's connected and when it last synced.
// POST { a: "sync" } + x-cron-secret Runs the sync (pg_cron, every 5 minutes; see supabase/gtasks.sql).
//
// The watch token is checked against the SHA-256 at app "alfred", key "watch/token".
// Sync state (list ids, which Errand Book task is which Google task) lives at app "alfred", key "gtasks/state".
// Secrets (Supabase -> Edge Functions -> Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Deploy with verify_jwt off: supabase functions deploy alfred-gtasks --no-verify-jwt

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const TZ = "America/New_York";
const SELF = "https://llirhlpsfylhbvogjutj.supabase.co/functions/v1/alfred-gtasks";
const SCOPE = "https://www.googleapis.com/auth/tasks";
const API = "https://tasks.googleapis.com/tasks/v1";
const LISTS = { errands: "Errands", ideas: "Ideas" };
// Items in the default list ("My Tasks") changed after this are swept into the Errand Book.
const DEFAULT_SINCE = "2026-11-22T18:00:00.000Z";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Add ${k} as a Supabase secret first.`);
  return v;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const weekday = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);

async function sha256(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Ctx = { db: SupabaseClient; owner: string; cron: string };

async function row(c: Ctx, app: string, key: string) {
  const { data, error } = await c.db.from("app_data").select("value")
    .eq("user_id", c.owner).eq("app", app).eq("key", key).eq("deleted", false).maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}
async function put(c: Ctx, app: string, key: string, value: unknown) {
  const { error } = await c.db.from("app_data")
    .upsert({ user_id: c.owner, app, key, value, deleted: false }, { onConflict: "user_id,app,key" });
  if (error) throw error;
}
async function checkToken(c: Ctx, t: string) {
  const stored = await row(c, "alfred", "watch/token");
  if (!t || !stored?.hash || (await sha256(t)) !== stored.hash) throw new HttpError(401, "Wrong token.");
}

Deno.serve(async (req) => {
  try {
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: cfgText, error: cfgErr } = await db.rpc("alfred_notion_config");
    if (cfgErr || !cfgText) throw new HttpError(500, "The vault has no alfred_notion_config.");
    const cfg = JSON.parse(cfgText);
    const c: Ctx = { db, owner: cfg.owner, cron: cfg.cron };
    const q = Object.fromEntries(new URL(req.url).searchParams);

    if (req.method === "GET") {
      if (q.code && q.state) return text(await callback(c, q.code, q.state));
      if (q.error) return text(`Google said: ${q.error}. Nothing was connected.`, 400);
      if (q.a === "start") { await checkToken(c, q.t); return Response.redirect(await startUrl(c), 302); }
      if (q.a === "status") { await checkToken(c, q.t); return json(await status(c)); }
      throw new HttpError(400, "Unknown request.");
    }
    if (req.method !== "POST") throw new HttpError(405, "GET or POST only.");
    if (req.headers.get("x-cron-secret") !== c.cron) throw new HttpError(401, "Wrong secret.");
    const body = await req.json().catch(() => ({}));
    if (body.a === "sync") return json(await sync(c));
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    console.error(e);
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});

// ---------- Connecting ----------

async function startUrl(c: Ctx) {
  const ts = String(Date.now());
  const state = `${ts}.${await hmac(c.cron, "gtasks:" + ts)}`;
  const p = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: SELF, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function callback(c: Ctx, code: string, state: string) {
  const [ts, sig] = state.split(".");
  if (!ts || sig !== await hmac(c.cron, "gtasks:" + ts) || Date.now() - Number(ts) > 15 * 60_000) {
    throw new HttpError(400, "That sign-in link has expired. Start again from the guide.");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: SELF, grant_type: "authorization_code",
    }),
  });
  const out = await res.json();
  if (!res.ok || !out.refresh_token) throw new HttpError(502, `Google didn't hand over a token (${out.error || res.status}).`);
  const { error } = await c.db.rpc("alfred_secret_set", { secret_name: "alfred_gtasks_refresh", secret_value: out.refresh_token });
  if (error) throw error;
  const st = (await row(c, "alfred", "gtasks/state")) || {};
  await put(c, "alfred", "gtasks/state", { ...st, connectedAt: new Date().toISOString(), lastError: null });
  const first = await sync(c).catch((e) => ({ error: String(e?.message || e) }));
  return "Connected. Alfred will keep your Errands and Ideas lists in Google Tasks in step with the rooms.\n\n"
    + `First sync: ${JSON.stringify(first)}\n\nYou can close this page.`;
}

async function accessToken(c: Ctx) {
  const { data: refresh, error } = await c.db.rpc("alfred_secret_get", { secret_name: "alfred_gtasks_refresh" });
  if (error) throw error;
  if (!refresh) throw new HttpError(409, "Not connected to Google Tasks yet.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh, client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  const out = await res.json();
  if (!res.ok) throw new HttpError(502, `Google refused the refresh (${out.error || res.status}). Reconnect from the guide.`);
  return out.access_token as string;
}

async function status(c: Ctx) {
  const st = (await row(c, "alfred", "gtasks/state")) || {};
  const { data: refresh } = await c.db.rpc("alfred_secret_get", { secret_name: "alfred_gtasks_refresh" });
  return { connected: !!refresh, connectedAt: st.connectedAt ?? null, lastSync: st.lastSync ?? null,
    lastError: st.lastError ?? null, onWatch: Object.keys(st.map || {}).length };
}

// ---------- Google Tasks calls ----------

function api(token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404) return { notFound: true };
      throw new HttpError(502, `Google Tasks ${method} ${path.split("?")[0]}: ${res.status} ${out.error?.message || ""}`);
    }
    return out;
  };
}
type Call = ReturnType<typeof api>;
type GTask = { id: string; title?: string; notes?: string; due?: string; status?: string; deleted?: boolean; updated?: string };

async function ensureList(call: Call, title: string, known?: string) {
  if (known) {
    const got = await call("GET", `/users/@me/lists/${known}`);
    if (got && !got.notFound) return known;
  }
  const all = await call("GET", "/users/@me/lists?maxResults=100");
  const hit = (all?.items || []).find((l: { title: string }) => l.title.toLowerCase() === title.toLowerCase());
  if (hit) return hit.id as string;
  const made = await call("POST", "/users/@me/lists", { title });
  return made.id as string;
}
async function listTasks(call: Call, list: string): Promise<GTask[]> {
  const out: GTask[] = [];
  let page = "";
  do {
    const r = await call("GET", `/lists/${list}/tasks?showCompleted=true&showHidden=true&maxResults=100${page ? `&pageToken=${page}` : ""}`);
    out.push(...(r?.items || []));
    page = r?.nextPageToken || "";
  } while (page);
  return out.filter((t) => !t.deleted);
}

// ---------- The sync ----------

async function sync(c: Ctx) {
  const st = (await row(c, "alfred", "gtasks/state")) || {};
  try {
    const call = api(await accessToken(c));
    const errandsList = await ensureList(call, LISTS.errands, st.errandsList);
    const ideasList = await ensureList(call, LISTS.ideas, st.ideasList);
    const map: Record<string, string> = errandsList === st.errandsList ? { ...(st.map || {}) } : {};
    const n = { ticked: 0, captured: 0, ideas: 0, added: 0, removed: 0, updated: 0 };

    // Errand Book as it stands
    const { data, error } = await c.db.from("app_data").select("key,value,deleted")
      .eq("user_id", c.owner).eq("app", "todo").like("key", "tasks/%");
    if (error) throw error;
    const errands = new Map<string, any>();
    for (const r of data || []) if (!r.deleted) errands.set(r.key.slice(6), r.value);
    const t = today();
    const sunday = plusDays(t, (7 - weekday(t)) % 7);
    const wanted = (x: any) => x && !x.someday && !["done", "waiting"].includes(x.status)
      && !(x.snoozeUntil && x.snoozeUntil > t)
      && ((x.due && x.due <= sunday) || (x.source === "watch" && !x.due));
    // The watch only shows today's and upcoming tasks, so overdue and undated errands show as due today
    // there. Their real dates in the Errand Book are untouched.
    const shown = (x: any) => (!x.due || x.due < t ? t : x.due);

    const gtasks = await listTasks(call, errandsList);
    const byG = new Map(gtasks.map((g) => [g.id, g]));
    const gToE = new Map(Object.entries(map).map(([e, g]) => [g, e]));

    // Forget pairs whose Google task has gone (deleted on the watch or in Tasks).
    for (const [e, g] of Object.entries(map)) if (!byG.has(g)) delete map[e];

    for (const g of gtasks) {
      const eid = gToE.get(g.id);
      if (g.status === "completed") {
        // Ticked on the watch: tick it in the Errand Book, then clear it from Tasks.
        const x = eid ? errands.get(eid) : null;
        if (x && x.status !== "done") {
          const v = { ...x, status: "done", doneAt: new Date().toISOString(), wantsSlot: false };
          await put(c, "todo", `tasks/${eid}`, v); errands.set(eid!, v); n.ticked++;
        }
        await call("DELETE", `/lists/${errandsList}/tasks/${g.id}`);
        if (eid) delete map[eid];
        continue;
      }
      if (!eid) {
        // Added by voice: a new Errand Book task for Alfred to size and slot.
        const title = cap(clean(g.title));
        if (!title) continue;
        const id = newId();
        const v = { id, title, area: "", priority: "Normal", status: "todo", triage: true, wantsSlot: true,
          source: "watch", ...(g.notes ? { notes: g.notes } : {}), created: new Date().toISOString() };
        await put(c, "todo", `tasks/${id}`, v); errands.set(id, v); map[id] = g.id; n.captured++;
        if (title !== g.title) await call("PATCH", `/lists/${errandsList}/tasks/${g.id}`, { title });
      }
    }

    // Gemini often files spoken to-dos in the default list ("My Tasks") whatever list you name. New items
    // there become Errand Book triage tasks and move to the Errands list; ones starting "Idea" go to the
    // Writing Desk shelf. Older tasks are left alone.
    const since = st.defaultSince || DEFAULT_SINCE;
    const defaultList = await listTasks(call, "@default");
    const seenDefault = defaultList.filter((g) => g.status !== "completed").map((g) => g.updated);
    for (const g of defaultList) {
      // Skip dated tasks too: repeating reminders (such as "Hydrate") carry a date and would come back daily.
      if (g.status === "completed" || g.due || !g.updated || g.updated < since) continue;
      const raw = clean(g.title);
      if (!raw) continue;
      const id = newId();
      const idea = raw.match(/^ideas?\b[\s:,.\-]*(.+)$/i);
      if (idea) {
        // "Idea: ..." goes to the Writing Desk shelf instead.
        await put(c, "desk", `pieces/${id}`, { id, title: cap(idea[1]), track: "ilkwim", stage: "Idea", source: "watch",
          ...(g.notes ? { notes: g.notes } : {}), created: new Date().toISOString() });
        n.ideas++;
        await call("DELETE", `/lists/@default/tasks/${g.id}`);
        continue;
      }
      const title = cap(raw);
      const v = { id, title, area: "", priority: "Normal", status: "todo", triage: true, wantsSlot: true,
        source: "watch", ...(g.notes ? { notes: g.notes } : {}), created: new Date().toISOString() };
      await put(c, "todo", `tasks/${id}`, v); errands.set(id, v); n.captured++;
      const made = await call("POST", `/lists/${errandsList}/tasks`, { title, due: `${t}T00:00:00.000Z` });
      map[id] = made.id; byG.set(made.id, made);
      await call("DELETE", `/lists/@default/tasks/${g.id}`);
    }

    // Take off what's done, dropped or no longer this week; update titles and dates on the rest.
    for (const [eid, gid] of Object.entries(map)) {
      const x = errands.get(eid);
      if (!wanted(x)) {
        await call("DELETE", `/lists/${errandsList}/tasks/${gid}`); delete map[eid]; n.removed++;
        continue;
      }
      const g = byG.get(gid);
      const day = shown(x);
      if (g && g.status !== "completed" && (g.title !== x.title || (g.due || "").slice(0, 10) !== day)) {
        await call("PATCH", `/lists/${errandsList}/tasks/${gid}`, { title: x.title, due: `${day}T00:00:00.000Z` });
        n.updated++;
      }
    }

    // Put this week's errands on the watch, soonest last so they end up at the top.
    const toAdd = [...errands.entries()].filter(([eid, x]) => wanted(x) && !map[eid])
      .sort((a, b) => String(b[1].due || "9").localeCompare(String(a[1].due || "9")));
    for (const [eid, x] of toAdd) {
      const made = await call("POST", `/lists/${errandsList}/tasks`, { title: x.title, due: `${shown(x)}T00:00:00.000Z` });
      map[eid] = made.id; n.added++;
    }

    // Ideas: move each to the Writing Desk shelf, then clear it from Tasks.
    for (const g of await listTasks(call, ideasList)) {
      const title = cap(clean(g.title));
      if (g.status !== "completed" && title) {
        const id = newId();
        await put(c, "desk", `pieces/${id}`, { id, title, track: "ilkwim", stage: "Idea", source: "watch",
          ...(g.notes ? { notes: g.notes } : {}), created: new Date().toISOString() });
        n.ideas++;
      }
      await call("DELETE", `/lists/${ideasList}/tasks/${g.id}`);
    }

    await put(c, "alfred", "gtasks/state", { ...st, defaultSince: since, errandsList, ideasList, map, lastSync: new Date().toISOString(), lastError: null });
    return { ok: true, ...n, onWatch: Object.keys(map).length, inMyTasks: seenDefault };
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return { ok: false, connected: false };
    const msg = e instanceof Error ? e.message : String(e);
    await put(c, "alfred", "gtasks/state", { ...st, lastError: msg, lastErrorAt: new Date().toISOString() });
    throw e;
  }
}
