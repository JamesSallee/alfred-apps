// Shared sync layer for Alfred's apps.
// Every app keeps a local copy (so it opens instantly and works offline),
// queues its own changes in an outbox, and syncs with Supabase when signed in and online.

// supabase-js 2.45.4 is bundled locally (js/vendor) and loaded by each page as a classic script,
// so the apps work offline; it sets globalThis.supabase.
const { createClient } = globalThis.supabase;
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const TABLE = "app_data";
const read = (k, fallback) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked: in-memory only */ } };

// ---------- Sign-in (6-digit email code) ----------

export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}
export async function sendCode(email) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}
export async function verifyCode(email, token) {
  const { data, error } = await supabase.auth.verifyOtp({ email, token: token.trim(), type: "email" });
  if (error) throw error;
  return data.user;
}
export async function signOut() { await supabase.auth.signOut(); }
export function onAuthChange(fn) {
  return supabase.auth.onAuthStateChange((_event, session) => fn(session?.user ?? null)).data.subscription;
}

// ---------- Stores ----------

const stores = new Map();

/** Open (or reuse) the synced store for one app. */
export function openStore(app) {
  if (stores.has(app)) return stores.get(app);
  const store = new Store(app);
  stores.set(app, store);
  store.start();
  return store;
}

class Store {
  constructor(app) {
    this.app = app;
    this.cacheKey = `alfred:${app}:cache`;
    this.outboxKey = `alfred:${app}:outbox`;
    const cache = read(this.cacheKey, { rows: {}, since: null });
    this.rows = cache.rows;          // key -> { value, deleted, updated_at }
    this.since = cache.since;        // latest server updated_at we've seen
    this.outbox = read(this.outboxKey, {}); // key -> { value, deleted, seq }
    this.seq = 0;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.status = "starting";
    this.channel = null;
    this.flushing = null;
  }

  // ----- reading -----
  get(key, fallback = undefined) {
    const r = this.rows[key];
    return r && !r.deleted ? r.value : fallback;
  }
  /** All live items whose key starts with prefix, as [{ key, value }]. */
  list(prefix = "") {
    return Object.entries(this.rows)
      .filter(([k, r]) => !r.deleted && k.startsWith(prefix))
      .map(([key, r]) => ({ key, value: r.value }));
  }
  subscribe(fn) { this.listeners.add(fn); fn(this); return () => this.listeners.delete(fn); }
  onStatus(fn) { this.statusListeners.add(fn); fn(this.status); return () => this.statusListeners.delete(fn); }

  // ----- writing -----
  set(key, value) { this.#local(key, value, false); }
  remove(key) { this.#local(key, null, true); }

  #local(key, value, deleted) {
    this.rows[key] = { value, deleted, updated_at: this.rows[key]?.updated_at ?? null };
    this.outbox[key] = { value, deleted, seq: ++this.seq + Date.now() };
    this.#save();
    this.#emit();
    this.#scheduleFlush();
  }

  // ----- sync -----
  async start() {
    this.#emit();
    window.addEventListener("online", () => this.sync());
    window.addEventListener("offline", () => this.#setStatus("offline"));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.sync(); });
    onAuthChange(() => this.sync());
    await this.sync();
  }

  async sync() {
    const user = await currentUser();
    if (!user) { this.#unsubscribe(); return this.#setStatus("signed-out"); }
    if (!navigator.onLine) return this.#setStatus("offline");
    this.#setStatus("syncing");
    try {
      await this.#flush(user);
      await this.#pull();
      this.#subscribeRealtime();
      this.#setStatus(Object.keys(this.outbox).length ? "pending" : "saved");
    } catch (e) {
      console.warn(`[sync:${this.app}]`, e);
      this.#setStatus(navigator.onLine ? "error" : "offline");
    }
  }

  async #pull() {
    let q = supabase.from(TABLE).select("key,value,deleted,updated_at").eq("app", this.app).order("updated_at");
    if (this.since) q = q.gt("updated_at", this.since);
    const { data, error } = await q;
    if (error) throw error;
    data.forEach((row) => this.#applyRemote(row));
    this.#save();
    this.#emit();
  }

  #applyRemote(row) {
    if (!this.since || row.updated_at > this.since) this.since = row.updated_at;
    if (this.outbox[row.key]) return; // our unsent edit is newer
    this.rows[row.key] = { value: row.value, deleted: row.deleted, updated_at: row.updated_at };
  }

  #scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.sync(), 400); // batch rapid taps
  }

  async #flush(user) {
    if (this.flushing) return this.flushing;
    const entries = Object.entries(this.outbox);
    if (!entries.length) return;
    this.flushing = (async () => {
      const payload = entries.map(([key, o]) => ({ user_id: user.id, app: this.app, key, value: o.value, deleted: o.deleted }));
      const { data, error } = await supabase.from(TABLE).upsert(payload, { onConflict: "user_id,app,key" }).select("key,updated_at");
      if (error) throw error;
      const sent = Object.fromEntries(entries.map(([k, o]) => [k, o.seq]));
      data.forEach(({ key, updated_at }) => {
        if (this.outbox[key]?.seq === sent[key]) delete this.outbox[key]; // unchanged since we sent it
        if (this.rows[key]) this.rows[key].updated_at = updated_at;
      });
      this.#save();
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }

  #subscribeRealtime() {
    if (this.channel) return;
    this.channel = supabase
      .channel(`app_data:${this.app}`)
      .on("postgres_changes", { event: "*", schema: "public", table: TABLE, filter: `app=eq.${this.app}` }, (msg) => {
        if (!msg.new?.key) return;
        this.#applyRemote(msg.new);
        this.#save();
        this.#emit();
      })
      .subscribe();
  }
  #unsubscribe() { if (this.channel) { supabase.removeChannel(this.channel); this.channel = null; } }

  // ----- helpers -----
  #save() {
    write(this.cacheKey, { rows: this.rows, since: this.since });
    write(this.outboxKey, this.outbox);
  }
  #emit() { this.listeners.forEach((fn) => fn(this)); }
  #setStatus(s) { this.status = s; this.statusListeners.forEach((fn) => fn(s)); }

  /** Everything this app holds, for backups. */
  snapshot() { return Object.fromEntries(this.list().map(({ key, value }) => [key, value])); }
}

export const STATUS_TEXT = {
  starting: "Opening…",
  "signed-out": "Not signed in: saved on this device only",
  offline: "Offline: will sync when you're back",
  syncing: "Syncing…",
  pending: "Saving…",
  saved: "Saved",
  error: "Couldn't reach the database: will keep trying",
};

// ---------- Backups ----------

/** Download a JSON backup of the given apps' data. */
export function exportBackup(apps) {
  const data = { exported_at: new Date().toISOString(), apps: {} };
  apps.forEach((app) => { data.apps[app] = openStore(app).snapshot(); });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `alfred-backup-${data.exported_at.slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Restore a backup file made by exportBackup. Existing items with the same key are overwritten. */
export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  Object.entries(data.apps || {}).forEach(([app, items]) => {
    const store = openStore(app);
    Object.entries(items).forEach(([key, value]) => store.set(key, value));
  });
}
