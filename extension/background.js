// Send to Alfred: one tab at a time. Recipes go to the Larder's cookbook, articles to the Reading Room's shelf,
// and anything unclear asks where it belongs (the Reading Room shows the choice).
// It holds no sign-in and no data of its own. It opens the Reading Room in a small window with the link in the
// address (reading.html?url=…); the room, already signed in on this browser, shelves it and retitles itself
// "Shelved ✓", and this closes the window a moment later. If you're signed out, the window stays open to sign in.

const ROOM = "https://jamessallee.github.io/alfred-apps/reading.html";

// Looked at in the tab itself: the words in the article (for reading time), and whether the page calls itself a
// recipe or an article (schema.org markup or og:type). The tab sees the page even when a site turns robots away.
async function lookAt(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector("article") || document.querySelector("main") || document.body;
        const words = (el?.innerText || "").split(/\s+/).filter(Boolean).length;
        const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(" ");
        const has = (types) => new RegExp(`"@type"\\s*:\\s*(\\[[^\\]]*)?"(${types})"`).test(ld);
        const recipe = has("Recipe") || !!document.querySelector('[itemtype*="schema.org/Recipe"]');
        const article = has("Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|OpinionNewsArticle")
          || document.querySelector('meta[property="og:type"]')?.content === "article";
        return { words, recipe, article };
      },
    });
    return result || {};
  } catch { return {}; } // chrome:// pages and the Web Store can't be read
}
const toFor = (look) => (look.recipe ? "larder" : look.article || look.words > 300 ? "read" : "");

async function send({ url, title = "", words = 0, to = "" }) {
  if (!/^https?:/i.test(url || "")) return;
  const p = new URLSearchParams({ url, title, src: "extension" });
  if (words > 150) p.set("min", String(Math.max(1, Math.round(words / 230))));
  if (to) p.set("to", to);
  const win = await chrome.windows.create({ url: `${ROOM}?${p}`, type: "popup", width: 460, height: 620, focused: true });
  const tabId = win.tabs?.[0]?.id;
  const done = (id, info) => {
    if (id !== tabId || !info.title?.startsWith("Shelved")) return;
    chrome.tabs.onUpdated.removeListener(done);
    setTimeout(() => chrome.windows.remove(win.id).catch(() => {}), 1200);
  };
  chrome.tabs.onUpdated.addListener(done);
}

chrome.action.onClicked.addListener(async (tab) => {
  const look = await lookAt(tab.id);
  send({ url: tab.url, title: tab.title, words: look.words, to: toFor(look) });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "page", title: "Send to Alfred", contexts: ["page"] });
  chrome.contextMenus.create({ id: "link", title: "Send this link to Alfred", contexts: ["link"] });
  chrome.contextMenus.create({ id: "curio", title: "Send to Alfred's cabinet of curiosities", contexts: ["page", "link"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "link") return send({ url: info.linkUrl, title: info.selectionText || "" });
  if (info.menuItemId === "curio") return send({ url: info.linkUrl || tab.url, title: info.linkUrl ? (info.selectionText || "") : tab.title, to: "curio" });
  const look = await lookAt(tab.id);
  send({ url: tab.url, title: tab.title, words: look.words, to: toFor(look) });
});
