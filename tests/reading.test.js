import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeStore } from "./setup.js";

const { shelfOf, findUrl, siteOf, placeOf, suggestDrawer, readingFigure, archiveUrl, fmtTotal } = await import("../js/reading.js");
const { doorFigures } = await import("../js/rooms.js");

const NOW = Date.parse("2026-11-12T15:00:00Z");
const ago = (d) => new Date(NOW - d * 864e5).toISOString();

test("pieces go on the shelf for their length; unmeasured ones wait with 'An evening'", () => {
  assert.equal(shelfOf(4), "quick");
  assert.equal(shelfOf(10), "evening");
  assert.equal(shelfOf(30), "evening");
  assert.equal(shelfOf(31), "long");
  assert.equal(shelfOf(null), "evening");
});

test("a shared link is found in the url or in the text, without trailing punctuation", () => {
  assert.equal(findUrl("", "Worth a read: https://example.com/a?b=1)."), "https://example.com/a?b=1");
  assert.equal(findUrl("https://x.org/p", "other"), "https://x.org/p");
  assert.equal(findUrl("no link here"), "");
  assert.equal(siteOf("https://www.newyorker.com/x"), "newyorker.com");
  assert.equal(archiveUrl("https://a.com/b"), "https://archive.ph/newest/https://a.com/b");
});

test("untouched for 60 days goes to the attic; opening one brings it back; read is read", () => {
  assert.equal(placeOf({ kind: "read", savedAt: ago(10) }, NOW), "shelf");
  assert.equal(placeOf({ kind: "curio", savedAt: ago(10) }, NOW), "cabinet");
  assert.equal(placeOf({ kind: "read", savedAt: ago(61) }, NOW), "attic");
  assert.equal(placeOf({ kind: "read", savedAt: ago(90), openedAt: ago(2) }, NOW), "shelf");
  assert.equal(placeOf({ kind: "read", savedAt: ago(90), readAt: ago(1) }, NOW), "read");
  assert.equal(placeOf({ kind: "read", savedAt: ago(40) }, NOW, 30), "attic");
});

test("a curiosity's drawer is guessed from its words, or left loose", () => {
  assert.equal(suggestDrawer("Hilma af Klint, the painter"), "Art & design");
  assert.equal(suggestDrawer("an article about bees"), null, "'article' isn't art");
  assert.equal(suggestDrawer("That ramen place in Huntington"), "Places & outings");
  assert.equal(suggestDrawer("Kit, an AI tool"), "Tools & code");
  assert.equal(suggestDrawer("something"), null);
});

test("the Study door counts what's on the shelf, then the cabinet", () => {
  const reading = fakeStore({
    "items/a": { kind: "read", savedAt: new Date().toISOString(), minutes: 12 },
    "items/b": { kind: "read", savedAt: new Date().toISOString(), readAt: new Date().toISOString() },
    "items/c": { kind: "curio", savedAt: new Date().toISOString() },
  });
  assert.deepEqual(readingFigure(reading), { v: "1", c: "to read" });
  assert.deepEqual(doorFigures({ reading }).reading, { v: "1", c: "to read" });
  assert.deepEqual(readingFigure(fakeStore({ "items/c": { kind: "curio", savedAt: new Date().toISOString() } })), { v: "1", c: "curiosities" });
  assert.equal(readingFigure(fakeStore({})), null);
  assert.equal(fmtTotal(110), "1 hr 50 min");
});
