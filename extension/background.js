// Send to Alfred: one tab at a time, to the Reading Room.
// It holds no sign-in and no data of its own. It opens the Reading Room in a small window with the link in the
// address (reading.html?url=…); the room, already signed in on this browser, shelves it and retitles itself
// "Shelved ✓", and this closes the window a moment later. If you're signed out, the window stays open to sign in.

const ROOM = "https://jamessallee.github.io/alfred-apps/reading.html";

// Reading time comes from the words in the article (or the main part of the page), counted in the tab itself.
async function countWords(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector("article") || document.querySelector("main") || document.body;
        return (el?.innerText || "").split(/\s+/).filter(Boolean).length;
      },
    });
    return result || 0;
  } catch { return 0; } // chrome:// pages and the Web Store can't be read
}

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
  send({ url: tab.url, title: tab.title, words: await countWords(tab.id) });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "page", title: "Send to Alfred", contexts: ["page"] });
  chrome.contextMenus.create({ id: "link", title: "Send this link to Alfred", contexts: ["link"] });
  chrome.contextMenus.create({ id: "curio", title: "Send to Alfred's cabinet of curiosities", contexts: ["page", "link"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "link") return send({ url: info.linkUrl, title: info.selectionText || "" });
  if (info.menuItemId === "curio") return send({ url: info.linkUrl || tab.url, title: info.linkUrl ? (info.selectionText || "") : tab.title, to: "curio" });
  send({ url: tab.url, title: tab.title, words: await countWords(tab.id) });
});
