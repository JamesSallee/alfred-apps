// Alfred on the wrist, through Google Tasks (no extra apps on the phone or watch).
//
// The Pixel Watch's Google Calendar app shows Google Tasks and has a tile, and Gemini on the watch can add
// to a named Tasks list. This function keeps two Google Tasks lists in step with the rooms:
//   "Errands"  Errand Book tasks due today or this week (to Sunday), plus overdue ones (shown as due today).
//              Chores (area "Chores") only on the day they're booked.
//              Tick one on the watch and it's ticked in the Errand Book. Anything added by voice
//              ("add stamps to my Errands list") becomes an Errand Book triage task, and so does anything
//              new in the default "My Tasks" list, where Gemini often files things.
//   "Ideas"    Anything added here ("add ... to my Ideas list") moves to the Writing Desk idea shelf
//              (ILKWIM, stage Idea) and is cleared from Tasks.
// It also reads the primary Google Calendar (read-only) for yesterday, today and tomorrow, so the Daily Ledger can
// treat a calendar block and its habit or errand as one item (js/calendar.js). Only events James created himself are
// kept (Alfred's ◆ blocks are made under his account); invitations and events anyone else created are dropped.
// They're written to app "alfred", key "calendar/<YYYY-MM-DD>": { day, events: [{ id, rid, title, start, end,
// allDay, alfred }], at }. Days older than 14 are cleared. Calendar access was added on 28 Nov 2026: until the owner
// reconnects (?a=start) to grant it, the calendar step records "needs permission" and the Tasks sync carries on.
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
const SCOPE = "https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events.readonly";
const CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CAL_KEEP_DAYS = 14;
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
  return "Connected. Alfred will keep your Errands and Ideas lists in Google Tasks in step with the rooms, and the Ledger will see today's calendar.\n\n"
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
    lastError: st.lastError ?? null, onWatch: Object.keys(st.map || {}).length, calendar: st.calendar ?? null };
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
    const token = await accessToken(c);
    const call = api(token);
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
    // Household chores (area "Chores") reach the watch only on the day they're booked, so a week of
    // planned chores doesn't sit there as "due today" every day.
    const isChore = (x: any) => String(x?.area || "").toLowerCase() === "chores";
    const bookedDay = (x: any) => (x?.booked?.start ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(x.booked.start)) : null);
    const wanted = (x: any) => x && !x.someday && !["done", "waiting"].includes(x.status)
      && !(x.snoozeUntil && x.snoozeUntil > t)
      && (isChore(x) ? bookedDay(x) === t : (x.due && x.due <= sunday) || (x.source === "watch" && !x.due)
        || (typeof x.planFor === "string" && x.planFor.length > 7 && x.planFor <= sunday)); // planned for this week
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

    // The calendar, for the Ledger. Its own try: a calendar problem never stops the errands reaching the watch.
    let calendar: Record<string, unknown>;
    try { calendar = await syncCalendar(c, token); }
    catch (e) { calendar = { ok: false, error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() }; }

    await put(c, "alfred", "gtasks/state", { ...st, defaultSince: since, errandsList, ideasList, map, calendar, lastSync: new Date().toISOString(), lastError: null });
    return { ok: true, ...n, onWatch: Object.keys(map).length, inMyTasks: seenDefault, calendar };
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return { ok: false, connected: false };
    const msg = e instanceof Error ? e.message : String(e);
    await put(c, "alfred", "gtasks/state", { ...st, lastError: msg, lastErrorAt: new Date().toISOString() });
    throw e;
  }
}

// ---------- The calendar, for the Ledger ----------

type GEvent = {
  id: string; status?: string; summary?: string; description?: string; recurringEventId?: string;
  start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string };
  creator?: { self?: boolean }; organizer?: { self?: boolean };
  attendees?: { self?: boolean; responseStatus?: string }[]; eventType?: string;
};
const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

async function syncCalendar(c: Ctx, token: string) {
  const t = today(), days = [plusDays(t, -1), t, plusDays(t, 1)];
  const p = new URLSearchParams({
    singleEvents: "true", orderBy: "startTime", maxResults: "250",
    // A day either side, so every New York day is whole whatever the offset; events are bucketed by their local day.
    timeMin: `${plusDays(t, -2)}T12:00:00Z`, timeMax: `${plusDays(t, 3)}T12:00:00Z`,
    fields: "items(id,status,summary,description,recurringEventId,start,end,creator(self),organizer(self),attendees(self,responseStatus),eventType)",
  });
  const res = await fetch(`${CAL_API}?${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const out = await res.json().catch(() => ({}));
  if (res.status === 403 || res.status === 401) {
    return { ok: false, needsPermission: true, at: new Date().toISOString(),
      error: "The Google connection doesn't include the calendar yet. Reconnect once (the watch guide's start link) to allow it." };
  }
  if (!res.ok) throw new Error(`Google Calendar: ${res.status} ${out.error?.message || ""}`);

  const byDay: Record<string, unknown[]> = Object.fromEntries(days.map((d) => [d, []]));
  for (const e of (out.items || []) as GEvent[]) {
    if (e.status === "cancelled" || !e.start) continue;
    if (e.eventType && !["default", "fromGmail"].includes(e.eventType)) continue; // no out-of-office or working-location blocks
    const mine = !!(e.creator?.self || e.organizer?.self);
    const declined = (e.attendees || []).some((a) => a.self && a.responseStatus === "declined");
    if (!mine || declined) continue; // Maggie's events, invitations and anything declined never count
    const title = clean(e.summary);
    if (!title) continue;
    const allDay = !!e.start.date;
    const day = allDay ? e.start.date! : dayOf(e.start.dateTime!);
    if (!byDay[day]) continue;
    byDay[day].push({
      id: e.id, rid: e.recurringEventId || null, title, allDay,
      start: e.start.dateTime || e.start.date || null, end: e.end?.dateTime || e.end?.date || null,
      alfred: title.startsWith("◆") || /scheduled by alfred/i.test(e.description || ""),
    });
  }
  const at = new Date().toISOString();
  // Rewrite a day only when its events changed, so the rooms aren't sent the same day every 5 minutes.
  for (const d of days) {
    const was = await row(c, "alfred", `calendar/${d}`);
    if (!was || JSON.stringify(was.events) !== JSON.stringify(byDay[d])) await put(c, "alfred", `calendar/${d}`, { day: d, events: byDay[d], at });
  }

  // Clear days older than two weeks.
  const { data } = await c.db.from("app_data").select("key")
    .eq("user_id", c.owner).eq("app", "alfred").like("key", "calendar/%").eq("deleted", false);
  const cutoff = plusDays(t, -CAL_KEEP_DAYS);
  for (const r of data || []) {
    const d = r.key.slice(9);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) {
      await c.db.from("app_data").update({ deleted: true, value: null }).eq("user_id", c.owner).eq("app", "alfred").eq("key", r.key);
    }
  }
  return { ok: true, at, events: days.map((d) => byDay[d].length) };
}
