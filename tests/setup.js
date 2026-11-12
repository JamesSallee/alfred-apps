// Lets the browser modules load under Node: a stand-in for the bundled supabase-js and for localStorage.
// Nothing here talks to Supabase.
const noop = () => {};
globalThis.supabase = {
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: noop } } }) },
    functions: { invoke: async () => ({ data: null }) },
  }),
};
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

/** A store with the same reading and writing calls as js/sync.js, held in memory. */
export function fakeStore(rows = {}, status = "saved") {
  const data = { ...rows };
  return {
    status,
    get: (k, fallback) => (k in data ? data[k] : fallback),
    set: (k, v) => { data[k] = v; },
    remove: (k) => { delete data[k]; },
    list: (prefix = "") => Object.entries(data).filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    data,
  };
}
