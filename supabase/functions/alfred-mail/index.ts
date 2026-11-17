// Alfred's morning note, sent by email from "Alfred" rather than from the owner's own Gmail
// (mail you send yourself never makes the phone ping).
//
// POST { action: "send", key: "outbox/<YYYY-MM-DD>" }  with x-cron-secret
//     Reads that row (app "alfred"), renders it in the Study's look and sends it through Resend.
//     Writes sentAt and the Resend id (or the error) back onto the row.
//     Row value: { subject, preheader?, greeting?, sections: [{ heading, items: [string | { text, followup? }] }], signoff? }
//     An item with `followup` (a followups/<id> id such as "f-will") gets Done / Drop / In 3 days links.
// POST { action: "tap", f: <followup id>, a: "done"|"drop"|"later", s: <signature> }
//     From followup.html, which the email's buttons open. Each link is signed with the cron secret, so only
//     links Alfred wrote work. The page asks for a tap before posting, so mail scanners that open links
//     can't settle anything by themselves.
//
// Who may call it: SQL with the shared secret (public.alfred_mail_send), or a signed tap.
// Secrets (Supabase -> Edge Functions -> Secrets):
//   RESEND_API_KEY   from resend.com
// It only ever sends to the owner's own sign-in email (on Resend's free plan, the address Resend was signed up with).
// The owner and the cron secret come from the vault's "alfred_notion_config" (see supabase/notion.sql).
// Deploy with verify_jwt off: supabase functions deploy alfred-mail --no-verify-jwt

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const TZ = "America/New_York";
const FROM = "Alfred <onboarding@resend.dev>";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const env = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new HttpError(500, `Add ${k} as a Supabase secret first.`);
  return v;
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const PAGE = "https://jamessallee.github.io/alfred-apps/followup.html";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const plusDays = (iso: string, n: number) => {
  const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

async function sign(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  try {
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
    const { data: cfgText, error: cfgErr } = await db.rpc("alfred_notion_config");
    if (cfgErr || !cfgText) throw new HttpError(500, "The vault has no alfred_notion_config.");
    const cfg = JSON.parse(cfgText) as { owner: string; cron: string };

    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.action === "tap") return json(await tap(db, cfg, body));
    if (req.headers.get("x-cron-secret") !== cfg.cron) throw new HttpError(401, "Wrong secret.");
    if (body.action === "send" && typeof body.key === "string" && body.key.startsWith("outbox/")) {
      return json(await send(db, cfg, body.key));
    }
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});

// ---------- Sending ----------

type Item = string | { text: string; followup?: string };
type Note = { subject: string; preheader?: string; greeting?: string; sections?: { heading: string; items: Item[] }[]; signoff?: string };

async function send(db: SupabaseClient, cfg: { owner: string; cron: string }, key: string) {
  const { data: row, error } = await db.from("app_data").select("value")
    .eq("user_id", cfg.owner).eq("app", "alfred").eq("key", key).eq("deleted", false).maybeSingle();
  if (error) throw error;
  if (!row?.value?.subject) throw new HttpError(404, `No note at ${key}.`);
  const note = row.value as Note & { sentAt?: string };
  if (note.sentAt) return { already: note.sentAt };

  const links = async (id: string) => {
    const out: Record<string, string> = {};
    for (const a of ["done", "drop", "later"]) out[a] = `${PAGE}?f=${encodeURIComponent(id)}&a=${a}&s=${await sign(cfg.cron, `${id}:${a}`)}`;
    return out;
  };
  const { data: who, error: whoErr } = await db.auth.admin.getUserById(cfg.owner);
  if (whoErr || !who?.user?.email) throw new HttpError(500, "Can't find the owner's email.");
  const to = who.user.email;
  const html = await render(note, links);
  const text = plain(note);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: to, subject: note.subject, html, text }),
  });
  const out = await res.json().catch(() => ({}));
  const patch = res.ok ? { sentAt: new Date().toISOString(), resendId: out.id, error: null } : { error: `Resend ${res.status}: ${out.message || res.statusText}` };
  await db.from("app_data").update({ value: { ...note, ...patch } })
    .eq("user_id", cfg.owner).eq("app", "alfred").eq("key", key);
  if (!res.ok) throw new HttpError(502, patch.error as string);
  return patch;
}

const C = { bg: "#eef1ec", paper: "#f8faf6", ink: "#1d2b24", muted: "#5d6b63", line: "#d3dbd4", green: "#1f4d3a", onGreen: "#f4f7f2", brass: "#a87a1f", brassSoft: "#f3e7c8", brassInk: "#7a5810" };
const SERIF = `"Young Serif", Georgia, "Times New Roman", serif`;
const SANS = `Figtree, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

async function render(n: Note, links: (id: string) => Promise<Record<string, string>>) {
  const btn = (href: string, label: string, solid = false) =>
    `<a href="${esc(href)}" style="display:inline-block;margin:6px 6px 0 0;padding:5px 12px;border-radius:999px;font:600 13px ${SANS};text-decoration:none;${solid ? `background:${C.green};color:${C.onGreen};` : `border:1px solid ${C.line};color:${C.green};background:#fff;`}">${label}</a>`;
  let body = "";
  for (const s of n.sections || []) {
    if (!s.items?.length) continue;
    let rows = "";
    for (const it of s.items) {
      const t = typeof it === "string" ? it : it.text;
      const f = typeof it === "string" ? undefined : it.followup;
      let extra = "";
      if (f) {
        const l = await links(f);
        extra = `<div>${btn(l.done, "Done", true)}${btn(l.later, "In 3 days")}${btn(l.drop, "Drop")}</div>`;
      }
      rows += `<tr><td style="padding:9px 0;border-top:1px solid ${C.line};font:15px/1.5 ${SANS};color:${C.ink}">${esc(t)}${extra}</td></tr>`;
    }
    body += `<tr><td style="padding:18px 24px 4px"><div style="font:600 11px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${C.brassInk}">${esc(s.heading)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${rows}</table></td></tr>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(n.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(n.preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.paper};border:1px solid ${C.line};border-radius:14px;overflow:hidden">
<tr><td style="background:${C.green};padding:18px 24px">
  <div style="font:22px ${SERIF};color:${C.onGreen}">&#9670; Alfred</div>
  <div style="font:13px ${SANS};color:${C.onGreen};opacity:.8;margin-top:2px">${esc(n.subject.replace(/^Alfred\s*·\s*/, ""))}</div>
</td></tr>
${n.greeting ? `<tr><td style="padding:20px 24px 0;font:16px/1.55 ${SANS};color:${C.ink}">${esc(n.greeting)}</td></tr>` : ""}
${body}
<tr><td style="padding:20px 24px 22px;font:14px/1.5 ${SANS};color:${C.muted}">${esc(n.signoff || "Reply to this email to settle anything else: done, drop, or a new date.")}</td></tr>
</table>
<div style="font:12px ${SANS};color:${C.muted};padding:12px">Sent by Alfred from your Study.</div>
</td></tr></table></body></html>`;
}

function plain(n: Note) {
  const out = [n.greeting || ""];
  for (const s of n.sections || []) {
    if (!s.items?.length) continue;
    out.push("", s.heading.toUpperCase());
    for (const it of s.items) out.push("- " + (typeof it === "string" ? it : it.text));
  }
  out.push("", n.signoff || "Reply to this email to settle anything else: done, drop, or a new date.");
  return out.join("\n").trim();
}

// ---------- The Done / Drop / In 3 days taps ----------

async function tap(db: SupabaseClient, cfg: { owner: string; cron: string }, b: { f?: string; a?: string; s?: string }) {
  const f = String(b.f || ""), a = String(b.a || ""), s = String(b.s || "");
  if (!/^[\w-]{1,60}$/.test(f) || !["done", "drop", "later"].includes(a) || s !== await sign(cfg.cron, `${f}:${a}`)) {
    throw new HttpError(400, "That link doesn't look like one of mine.");
  }
  const key = `followups/${f}`;
  const { data: row, error } = await db.from("app_data").select("value")
    .eq("user_id", cfg.owner).eq("app", "alfred").eq("key", key).eq("deleted", false).maybeSingle();
  if (error) throw error;
  if (!row?.value) throw new HttpError(404, "I can't find that follow-up any more.");
  const v = row.value;
  const later = plusDays(today(), 3);
  const patch = a === "done" ? { status: "done", settledAt: today(), settledBy: "link" }
    : a === "drop" ? { status: "dropped", settledAt: today(), settledBy: "link" }
    : { status: "open", checkOn: later };
  const { error: upErr } = await db.from("app_data").update({ value: { ...v, ...patch } })
    .eq("user_id", cfg.owner).eq("app", "alfred").eq("key", key);
  if (upErr) throw upErr;
  return { ok: true, what: String(v.what || ""), a, checkOn: a === "later" ? later : undefined };
}
