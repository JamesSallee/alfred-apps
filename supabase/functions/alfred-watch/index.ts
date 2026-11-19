// Alfred on the wrist: a tiny API for Tasker + AutoWear on the Pixel Watch.
//
// Every call needs the header  x-watch-token: <token>.
// Only the token's SHA-256 is stored, at app "alfred", key "watch/token" ({ hash }).
// To change the token, write a new hash there; the old one stops working at once.
//
// GET  ?a=list
//     Errand Book tasks due today or this week (to Sunday), plus anything overdue.
//     Errands only: no habits. Skips done, waiting, someday and snoozed tasks.
//     Returns { count, items: [{ id, title, due, when, high }], titles, ids, text }
//     `titles` and `ids` are joined with "~" for AutoWear lists; `text` is one line per task.
// POST { a: "done", id }            Ticks a task off, as the Errand Book does.
// POST { a: "errand", text }        New Errand Book task, flagged triage so Alfred sizes and slots it.
// POST { a: "idea", text }          New idea on the Writing Desk idea shelf (ILKWIM, stage Idea).
//     Long dictation (a writing walk) keeps a short title and puts the whole thing in notes.
// GET or POST may also send the fields as query parameters (a, id, text), which is easier in Tasker.
//
// Deploy with verify_jwt off: supabase functions deploy alfred-watch --no-verify-jwt

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const TZ = "America/New_York";
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Missing ${k}.`);
  return v;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const weekday = (iso: string) => new Date(iso + "T12:00:00Z").getUTCDay(); // 0 = Sunday
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function sha256(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Ctx = { db: SupabaseClient; owner: string };

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

Deno.serve(async (req) => {
  try {
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: cfgText, error: cfgErr } = await db.rpc("alfred_notion_config");
    if (cfgErr || !cfgText) throw new HttpError(500, "The vault has no alfred_notion_config.");
    const c: Ctx = { db, owner: JSON.parse(cfgText).owner };

    const token = req.headers.get("x-watch-token") || "";
    const stored = await row(c, "alfred", "watch/token");
    if (!token || !stored?.hash || (await sha256(token)) !== stored.hash) throw new HttpError(401, "Wrong token.");

    const q = Object.fromEntries(new URL(req.url).searchParams);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const p = { ...q, ...body } as Record<string, string>;
    const a = p.a || "list";

    if (a === "list") return json(await list(c));
    if (req.method !== "POST") throw new HttpError(405, "Use POST for changes.");
    if (a === "done") return json(await done(c, String(p.id || "")));
    if (a === "errand") return json(await errand(c, clean(p.text)));
    if (a === "idea") return json(await idea(c, clean(p.text)));
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});

async function list(c: Ctx) {
  const t = today();
  const sunday = plusDays(t, (7 - weekday(t)) % 7);
  const { data, error } = await c.db.from("app_data").select("key,value")
    .eq("user_id", c.owner).eq("app", "todo").like("key", "tasks/%").eq("deleted", false);
  if (error) throw error;
  const items = (data || []).map((r) => ({ id: r.key.slice(6), ...r.value }))
    .filter((x) => x.due && x.due <= sunday && !x.someday && !["done", "waiting"].includes(x.status)
      && !(x.snoozeUntil && x.snoozeUntil > t))
    .sort((x, y) => x.due.localeCompare(y.due) || Number(y.priority === "High") - Number(x.priority === "High")
      || (x.order ?? 0) - (y.order ?? 0))
    .map((x) => ({
      id: x.id,
      title: String(x.title || "").replace(/~/g, "-"),
      due: x.due,
      when: x.due < t ? "Overdue" : x.due === t ? "Today" : DAYS[weekday(x.due)],
      high: x.priority === "High",
    }));
  return {
    count: items.length,
    items,
    titles: items.map((x) => x.title).join("~"),
    ids: items.map((x) => x.id).join("~"),
    text: items.length ? items.map((x) => `${x.when}: ${x.title}`).join("\n") : "Nothing due this week.",
  };
}

async function done(c: Ctx, id: string) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new HttpError(400, "Bad id.");
  const key = `tasks/${id}`;
  const v = await row(c, "todo", key);
  if (!v) throw new HttpError(404, "I can't find that task.");
  if (v.status === "done") return { ok: true, already: true, title: v.title };
  await put(c, "todo", key, { ...v, status: "done", doneAt: new Date().toISOString(), wantsSlot: false });
  return { ok: true, title: v.title, say: `Done: ${v.title}` };
}

async function errand(c: Ctx, text: string) {
  if (!text) throw new HttpError(400, "Say the errand first.");
  const title = text.charAt(0).toUpperCase() + text.slice(1);
  const id = newId();
  await put(c, "todo", `tasks/${id}`, {
    id, title, area: "", priority: "Normal", status: "todo", triage: true, wantsSlot: true,
    source: "watch", created: new Date().toISOString(),
  });
  return { ok: true, id, say: `On the list: ${title}` };
}

async function idea(c: Ctx, text: string) {
  if (!text) throw new HttpError(400, "Say the idea first.");
  const long = text.length > 90;
  let title = text;
  if (long) {
    const first = text.split(/(?<=[.!?])\s/)[0];
    title = first.length <= 90 ? first : text.slice(0, 87).replace(/\s+\S*$/, "") + "…";
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);
  const id = newId();
  await put(c, "desk", `pieces/${id}`, {
    id, title, track: "ilkwim", stage: "Idea", source: "watch",
    ...(long ? { notes: `Dictated on the watch:\n${text}` } : {}),
    created: new Date().toISOString(),
  });
  return { ok: true, id, say: `On the shelf: ${title}` };
}
