// A small stand-in for the document-database API the apps were first written against
// (collection / doc / set / delete / onSnapshot / orderBy / limit), backed by the synced Store.
// Paths map to store keys: doc("days/2026-11-02") -> key "days/2026-11-02".

import { openStore } from "./sync.js";

export function openDb(app) {
  const store = openStore(app);

  const docSnap = (key) => {
    const value = store.get(key);
    return { id: key.split("/").pop(), exists: value !== undefined, data: () => value };
  };

  function doc(path) {
    return {
      id: path.split("/").pop(),
      async get() { return docSnap(path); },
      async set(value, opts) {
        const next = opts && opts.merge ? { ...(store.get(path) || {}), ...value } : value;
        store.set(path, JSON.parse(JSON.stringify(next)));
      },
      async update(patch) { store.set(path, { ...(store.get(path) || {}), ...JSON.parse(JSON.stringify(patch)) }); },
      async delete() { store.remove(path); },
      onSnapshot(next) { return store.subscribe(() => next(docSnap(path))); },
    };
  }

  function query(name, order = null, max = null) {
    const prefix = name + "/";
    const run = () => {
      let docs = store.list(prefix)
        .filter(({ key }) => !key.slice(prefix.length).includes("/"))
        .map(({ key, value }) => ({ id: key.slice(prefix.length), data: () => value }));
      if (order) {
        const [field, dir] = order;
        docs.sort((a, b) => {
          const x = a.data()?.[field], y = b.data()?.[field];
          return (x > y ? 1 : x < y ? -1 : 0) * (dir === "desc" ? -1 : 1);
        });
      }
      if (max != null) docs = docs.slice(0, max);
      return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false } };
    };
    return {
      doc: (id) => doc(prefix + id),
      orderBy: (field, dir = "asc") => query(name, [field, dir], max),
      limit: (n) => query(name, order, n),
      async get() { return run(); },
      onSnapshot(next) { return store.subscribe(() => next(run())); },
    };
  }

  return { doc, collection: (name) => query(name) };
}
