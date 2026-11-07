// Alfred's one-way copies into Notion, and the weekly backup.
//
// POST { action: "mirror" }  Copies changes one way into Notion:
//                              Errand Book ("todo" / "tasks/<id>")   -> the Notion Tasks database
//                              Writing Desk ("desk" / "pieces/<id>") -> the "Writing Desk" database under the ILKWIM Writing Plan
//                            The rooms are the master; Notion is a readable spare. Edits made in Notion are not
//                            read back, and are overwritten the next time that item changes in its room.
// POST { action: "backup" }  Writes every room's data (the same JSON the account sheet's Export makes, so
//                            Restore can read it) to a file on the Notion backups page. Wardrobe photos are
//                            not included: they live in Supabase Storage.
//
// Who may call it: the owner, signed in (the Errand Book nudges a mirror a few seconds after an edit), or
// pg_cron with the shared secret (hourly mirror, Sunday backup; see supabase/notion.sql). The scheduled calls
// also keep a free Supabase project from pausing when the apps go unused for a week.
//
// Secret (Supabase -> Edge Functions -> Secrets):
//   NOTION_TOKEN  an internal integration's secret, with Home shared to it (Tasks, the Writing Desk database, Alfred backups)
// Everything else (the owner, the cron secret, the Notion ids) lives in the vault as "alfred_notion_config"
// (see supabase/notion.sql), so nothing personal sits in this public repo.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TZ = "America/New_York";
const STATUS: Record<string, string> = { todo: "To do", doing: "Doing", waiting: "Waiting", done: "Done" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** From the vault: { owner, cron, tasksDb, deskDb, backupPage }. */
const CFG: Record<string, string> = {};
const cfg = (k: string) => {
  if (!CFG[k]) throw new HttpError(500, `alfred_notion_config has no "${k}".`);
  return CFG[k];
};
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Add ${k} as a Supabase secret first.`);
  return v;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: cfgText, error: cfgErr } = await db.rpc("alfred_notion_config");
    if (cfgErr || !cfgText) throw new HttpError(500, "Run supabase/notion.sql first: the vault has no alfred_notion_config.");
    Object.assign(CFG, JSON.parse(cfgText));
    const owner = CFG.owner;
    const cron = req.headers.get("x-cron-secret");
    if (cron) {
      if (cron !== CFG.cron) throw new HttpError(401, "Wrong secret.");
    } else {
      const anon = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
        global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      });
      const { data: { user } } = await anon.auth.getUser();
      if (!user) throw new HttpError(401, "Please sign in first.");
      if (user.id !== owner) throw new HttpError(403, "This is private to its owner.");
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === "mirror") {
      const out: Record<string, unknown> = {};
      for (const src of SOURCES) if (!body.app || body.app === src.app) out[src.app] = await mirror(db, owner, src);
      return json(out);
    }
    if (body.action === "backup") return json(await backup(db, owner));
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});

// ---------- Notion ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function notion(path: string, method: string, body?: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION + path, {
      method,
      headers: { Authorization: `Bearer ${env("NOTION_TOKEN")}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) { await sleep(Number(res.headers.get("Retry-After") || 1) * 1000); continue; }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Notion ${res.status}: ${out.message || res.statusText}`);
    await sleep(340); // Notion allows about three requests a second
    return out;
  }
}
const text = (s: string) => [{ type: "text", text: { content: s.slice(0, 2000) } }];

// ---------- State, kept in app_data under the app "notion" ----------

async function getRow(db: SupabaseClient, owner: string, key: string) {
  const { data, error } = await db.from("app_data").select("value,deleted,updated_at")
    .eq("user_id", owner).eq("app", "notion").eq("key", key).maybeSingle();
  if (error) throw error;
  return data && !data.deleted ? data : null;
}
async function setRow(db: SupabaseClient, owner: string, key: string, value: unknown, deleted = false) {
  const { error } = await db.from("app_data").upsert({ user_id: owner, app: "notion", key, value, deleted }, { onConflict: "user_id,app,key" });
  if (error) throw error;
}
/** Claim the right to create a Notion page for this item, so two overlapping runs never both create one. */
async function claim(db: SupabaseClient, owner: string, key: string): Promise<boolean> {
  const { data, error } = await db.from("app_data")
    .upsert({ user_id: owner, app: "notion", key, value: { pending: Date.now() }, deleted: false },
      { onConflict: "user_id,app,key", ignoreDuplicates: true })
    .select("key");
  if (error) throw error;
  if (data?.length) return true;
  const row = await getRow(db, owner, key);
  if (row && !row.value?.pageId && Date.now() - (row.value?.pending || 0) > 5 * 60e3) {
    await setRow(db, owner, key, { pending: Date.now() }); // a run died mid-way: take it over
    return true;
  }
  if (!row) { await setRow(db, owner, key, { pending: Date.now() }); return true; } // was soft-deleted
  return false;
}

// ---------- The Errand Book -> Notion Tasks ----------

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const size = (m: number) => m < 60 ? `${m} min` : m === 240 ? "half a day" : m >= 480 ? "a day" : `${m / 60} hr`;

function taskProps(t: any) {
  const notes = [
    t.notes,
    t.status === "waiting" && t.waitingOn ? `Waiting on: ${t.waitingOn}` : "",
    t.booked?.start ? `Booked: ${when(t.booked.start)}` : t.wantsSlot ? "Alfred to find a slot" : "",
    t.snoozeUntil && t.snoozeUntil > today() ? `Snoozed until ${t.snoozeUntil}` : "",
    t.size ? `About ${size(t.size)}` : "",
    t.someday ? "Someday" : "",
    "(Copied from the Errand Book: edit it there.)",
  ].filter(Boolean).join("\n");
  return {
    Task: { title: text(t.title || "Untitled") },
    Status: { status: { name: STATUS[t.status] || "To do" } },
    Priority: { select: t.priority ? { name: t.priority } : null },
    Area: { select: t.area ? { name: String(t.area).replace(/,/g, " ") } : null },
    Due: { date: t.due ? { start: t.due } : null },
    Notes: { rich_text: text(notes) },
  };
}

// ---------- The Writing Desk -> Notion "Writing Desk" ----------

const KIND: Record<string, string> = { ilkwim: "ILKWIM", fiction: "Fiction", comedy: "Comedy" };
const LAST: Record<string, string> = { ilkwim: "Out", fiction: "Done", comedy: "Done" };
const opt = (v?: string) => v ? { name: String(v).replace(/,/g, " ").slice(0, 100) } : null;
const day = (v?: string) => ({ date: v ? { start: v } : null });

function pieceProps(p: any) {
  const place = p.stage === "Skipped" ? "Skipped" : p.stage === LAST[p.track] ? "Finished" : p.publish ? "Schedule" : "Idea shelf";
  return {
    Title: { title: text(p.title || "Untitled") },
    Kind: { select: opt(KIND[p.track] || p.track) },
    Series: { select: opt(p.series) },
    Stage: { select: opt(p.stage) },
    Place: { select: opt(place) },
    Publish: day(p.publish),
    Gather: day(p.gather),
    Draft: day(p.draft),
    "Schedule by": day(p.due),
    Banked: { checkbox: !!p.banked },
    "Draft link": { url: p.link || null },
    Notes: { rich_text: text([p.notes, "(Copied from the Writing Desk: edit it there.)"].filter(Boolean).join("\n")) },
  };
}

// ---------- The mirror ----------

type Source = { app: string; prefix: string; dbKey: string; props: (v: any) => unknown; title: (v: any) => string | undefined };
const SOURCES: Source[] = [
  { app: "todo", prefix: "tasks/", dbKey: "tasksDb", props: taskProps, title: (v) => v?.title },
  { app: "desk", prefix: "pieces/", dbKey: "deskDb", props: pieceProps, title: (v) => v?.title },
];

async function mirror(db: SupabaseClient, owner: string, src: Source) {
  const sinceKey = `${src.app}Since`;
  const state = (await getRow(db, owner, "state"))?.value || {};
  let q = db.from("app_data").select("key,value,deleted,updated_at")
    .eq("user_id", owner).eq("app", src.app).like("key", src.prefix + "%").order("updated_at").limit(200);
  if (state[sinceKey]) q = q.gt("updated_at", state[sinceKey]);
  const { data: rows, error } = await q;
  if (error) throw error;

  let since = state[sinceKey] || null, created = 0, updated = 0, archived = 0, skipped = 0;
  const dbId = cfg(src.dbKey);
  const create = async (mapKey: string, value: any) => {
    const page = await notion("/pages", "POST", { parent: { database_id: dbId }, properties: src.props(value) });
    await setRow(db, owner, mapKey, { pageId: page.id });
    created++;
  };
  try {
    for (const row of rows || []) {
      const mapKey = `${src.app}/${row.key.slice(src.prefix.length)}`;
      const map = (await getRow(db, owner, mapKey))?.value;
      if (row.deleted || !src.title(row.value)) {
        if (map?.pageId) { await notion(`/pages/${map.pageId}`, "PATCH", { archived: true }).catch(() => {}); archived++; }
        if (map) await setRow(db, owner, mapKey, null, true);
      } else if (map?.pageId) {
        try {
          await notion(`/pages/${map.pageId}`, "PATCH", { properties: src.props(row.value), archived: false });
          updated++;
        } catch (e) {
          if (!/404|archived|trash/i.test(String(e))) throw e;
          await create(mapKey, row.value); // the Notion page was deleted by hand: make a fresh one
        }
      } else if (await claim(db, owner, mapKey)) {
        await create(mapKey, row.value);
      } else {
        skipped++; // another run is creating it right now
      }
      since = row.updated_at;
    }
  } finally {
    // Only move the marker past rows that were handled, so a failure is retried next time.
    if (since !== state[sinceKey]) {
      const now = (await getRow(db, owner, "state"))?.value || {};
      await setRow(db, owner, "state", { ...now, [sinceKey]: since, [`${src.app}At`]: new Date().toISOString() });
    }
  }
  return { created, updated, archived, skipped, more: (rows?.length || 0) === 200 };
}

// ---------- Weekly backup ----------

async function backup(db: SupabaseClient, owner: string) {
  const apps: Record<string, Record<string, unknown>> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("app_data").select("app,key,value")
      .eq("user_id", owner).eq("deleted", false).neq("app", "notion").order("app").order("key").range(from, from + 999);
    if (error) throw error;
    (data || []).forEach((r) => { (apps[r.app] ||= {})[r.key] = r.value; });
    if (!data || data.length < 1000) break;
  }
  const exported_at = new Date().toISOString();
  const file = JSON.stringify({ exported_at, apps });
  const name = `alfred-backup-${today()}.json`;

  // Notion's file upload: create, send the bytes, then attach it to the page as a file block.
  const up = await notion("/file_uploads", "POST", { filename: name, content_type: "application/json" });
  const form = new FormData();
  form.append("file", new Blob([file], { type: "application/json" }), name);
  const sent = await fetch(`${NOTION}/file_uploads/${up.id}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("NOTION_TOKEN")}`, "Notion-Version": NOTION_VERSION },
    body: form,
  });
  if (!sent.ok) throw new Error(`Notion upload ${sent.status}: ${(await sent.json().catch(() => ({}))).message || sent.statusText}`);
  const counts = Object.entries(apps).map(([a, items]) => `${a} ${Object.keys(items).length}`).join(", ");
  await notion(`/blocks/${cfg("backupPage")}/children`, "PATCH", {
    children: [{
      type: "file",
      file: { type: "file_upload", file_upload: { id: up.id }, name, caption: text(`${today()} · ${Math.round(file.length / 1024)} KB · ${counts}`) },
    }],
  });
  const state = (await getRow(db, owner, "state"))?.value || {};
  await setRow(db, owner, "state", { ...state, backupAt: exported_at, backupBytes: file.length });
  return { name, bytes: file.length, apps: Object.keys(apps).length };
}
