// Fails when a change touches a file the service worker caches but leaves CACHE in sw.js as it was,
// which would keep phones and the tablet console on the old version until the cache name changes.
// Usage: node scripts/check-cache-bump.js <base ref>   (CI passes the pull request's base branch)
import { execFileSync } from "node:child_process";

const base = process.argv[2] || "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const changed = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
const cached = (f) => /\.(html|webmanifest)$/.test(f) || /^(js|css)\//.test(f) || f === "icon.svg";
const touched = changed.filter(cached);
const cacheName = (src) => (/const CACHE = "([^"]+)"/.exec(src) || [])[1];
const before = cacheName(git("show", `${base}:sw.js`));
const after = cacheName(git("show", "HEAD:sw.js"));

if (touched.length && before === after) {
  console.error(`These cached files changed, but CACHE in sw.js is still "${after}":\n  ${touched.join("\n  ")}\nBump it (e.g. alfred-v${Number((after || "").replace(/\D/g, "")) + 1}).`);
  process.exit(1);
}
console.log(touched.length ? `CACHE bumped: ${before} -> ${after}` : "No cached files changed.");
