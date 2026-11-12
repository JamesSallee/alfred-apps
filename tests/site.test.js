// Checks that the site's lists agree with each other, so a new room or file isn't half-added.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { ROOMS, CONSOLE_ORDER, DATA_APPS } from "../js/registry.js";
import { ICONS } from "../js/icons.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const sw = read("sw.js");
const shell = JSON.parse("[" + /const SHELL = \[([\s\S]*?)\];/.exec(sw)[1] + "]");
const pages = readdirSync(root).filter((f) => f.endsWith(".html"));

test("every room in the registry has a page, an icon and a row in the README", () => {
  const readme = read("README.md");
  for (const r of ROOMS) {
    assert.ok(existsSync(new URL(r.href, root)), `${r.href} is missing`);
    assert.ok(ICONS[r.id], `no icon for ${r.id} in js/icons.js`);
    assert.ok(readme.includes("`" + r.href + "`"), `README table has no row for ${r.href}`);
  }
  for (const id of CONSOLE_ORDER) assert.ok(ROOMS.some((r) => r.id === id), `console lists unknown room ${id}`);
  assert.ok(DATA_APPS.includes("study"));
});

test("the offline cache (sw.js SHELL) lists every page, script, stylesheet and manifest", () => {
  const want = [
    ...pages,
    ...readdirSync(new URL("js/", root)).filter((f) => f.endsWith(".js")).map((f) => "js/" + f),
    ...readdirSync(new URL("js/vendor/", root)).map((f) => "js/vendor/" + f),
    ...readdirSync(new URL("css/", root)).map((f) => "css/" + f),
    ...readdirSync(root).filter((f) => f.endsWith(".webmanifest")),
  ];
  const missing = want.filter((f) => !shell.includes(f));
  assert.deepEqual(missing, [], "add these to SHELL in sw.js");
  const gone = shell.filter((f) => f !== "./" && !existsSync(new URL(f, root)));
  assert.deepEqual(gone, [], "SHELL lists files that don't exist");
});

test("every page loads the shared stylesheet before its own styles", () => {
  for (const p of pages) {
    const h = read(p);
    const link = h.indexOf('href="css/base.css"'), style = h.indexOf("<style>");
    assert.ok(link > 0 && link < style, `${p} should link css/base.css just before its <style>`);
  }
});
