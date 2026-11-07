// Shared chrome for every app: a small sync-status pill, plus a sheet for
// signing in with an emailed link, backups and signing out.

import { openStore, STATUS_TEXT, currentUser, sendCode, signInWithPassword, setPassword, signOut, onAuthChange, exportBackup, importBackup } from "./sync.js";
import { iconSvg } from "./icons.js";

const ALL_APPS = ["ledger", "focus", "shutdown", "larder", "desk", "wardrobe", "training", "todo"];

const CSS = `
.al-pill{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9999;display:flex;align-items:center;gap:6px;
  font:500 12px/1 system-ui,-apple-system,sans-serif;padding:7px 11px;border-radius:999px;border:1px solid var(--al-line);
  background:var(--al-bg);color:var(--al-ink);font-family:var(--body,system-ui);box-shadow:0 2px 10px rgba(0,0,0,.12);cursor:pointer}
.al-dot{width:8px;height:8px;border-radius:50%;background:var(--al-dot)}
.al-sheet{position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.35)}
.al-sheet[hidden]{display:none}
.al-card{width:min(420px,100%);margin:0 0 env(safe-area-inset-bottom);background:var(--al-bg);color:var(--al-ink);
  border-radius:16px 16px 0 0;padding:20px 16px 24px;font:15px/1.45 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:12px}
@media (min-width:600px){.al-sheet{align-items:center}.al-card{border-radius:16px}}
.al-card h2{margin:0;font-size:17px}
.al-card p{margin:0;color:var(--al-soft)}
.al-card input{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--al-line);background:transparent;color:inherit}
.al-row{display:flex;gap:8px;flex-wrap:wrap}
.al-btn{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid var(--al-line);background:transparent;color:inherit;cursor:pointer}
.al-btn.primary{background:var(--al-ink);color:var(--al-bg);border-color:var(--al-ink)}
.al-err{color:#b3261e}
.al-mark{display:inline-block;width:.95em;height:.95em;margin-right:.32em;vertical-align:-.08em;color:var(--green,currentColor)}
.al-mark svg{display:block;width:100%;height:100%}
.al-pill,.al-card{--al-bg:var(--paper,#fbf8f2);--al-ink:var(--ink,#22201c);--al-soft:var(--muted,#6b655b);--al-line:var(--line,#d9d2c5)}
`;

const DOT = { saved: "#3f8f5b", pending: "#c79a2b", syncing: "#c79a2b", offline: "#9a9385", "signed-out": "#b3261e", error: "#b3261e", starting: "#9a9385" };

/** Add the status pill and account sheet to the page. `app` is this page's store name, or null for the hub. */
export function mountShell(app) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  // The room's icon beside each header title, matching its door in the Study.
  const icon = iconSvg(app);
  if (icon) for (const h1 of document.querySelectorAll("header h1")) {
    if (h1.querySelector(".al-mark")) continue;
    const mark = document.createElement("span");
    mark.className = "al-mark";
    mark.innerHTML = icon;
    h1.prepend(mark);
  }

  const spacer = document.createElement("div"); // keeps the pill clear of the page's last line
  spacer.style.height = "56px";
  document.body.appendChild(spacer);

  const pill = document.createElement("button");
  pill.className = "al-pill";
  pill.type = "button";
  pill.innerHTML = '<span class="al-dot"></span><span class="al-txt"></span>';
  document.body.appendChild(pill);

  const sheet = document.createElement("div");
  sheet.className = "al-sheet";
  sheet.hidden = true;
  sheet.innerHTML = '<div class="al-card" role="dialog" aria-modal="true" aria-label="Account and sync"></div>';
  document.body.appendChild(sheet);
  const card = sheet.firstElementChild;
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.hidden = true; });

  const show = (status) => {
    pill.querySelector(".al-txt").textContent = STATUS_TEXT[status] || status;
    pill.style.setProperty("--al-dot", DOT[status] || "#9a9385");
  };
  openStore(app || "study").onStatus(show);

  pill.onclick = async () => { flash = ""; await renderSheet(); sheet.hidden = false; };
  onAuthChange(() => { if (!sheet.hidden) renderSheet(); });
  // The emailed link signs in wherever it opens, usually a new tab. When you come back to this one,
  // check again so the "check your email" card turns into "Signed in" by itself.
  const recheck = () => { if (!sheet.hidden && document.visibilityState === "visible") renderSheet(); };
  document.addEventListener("visibilitychange", recheck);
  window.addEventListener("focus", recheck);

  let email = "";
  let flash = ""; // a short confirmation that survives re-renders until the sheet changes step or closes
  async function renderSheet(step = null, err = "") {
    const user = await currentUser();
    const errHtml = (err ? `<p class="al-err">${escapeHtml(err)}</p>` : "") + (flash ? `<p>${escapeHtml(flash)}</p>` : "");
    if (user && step === "password") {
      card.innerHTML = `<h2>Set a password</h2><p>Then you can sign in on any device with ${escapeHtml(user.email || "your email")} and this password, no email needed.</p>
        <input type="password" autocomplete="new-password" placeholder="New password (8+ characters)" data-f="newpw">${errHtml}
        <div class="al-row"><button class="al-btn" data-a="back">Cancel</button><button class="al-btn primary" data-a="setpw">Save password</button></div>`;
    } else if (user) {
      card.innerHTML = `<h2>Signed in</h2><p>${escapeHtml(user.email || "")}. Everything saves automatically and syncs to your other devices.</p>
        <div class="al-row"><button class="al-btn" data-a="export">Export backup</button>
        <label class="al-btn">Restore backup<input type="file" accept="application/json" hidden data-a="import"></label></div>
        <div class="al-row"><button class="al-btn" data-a="password">Set or change password</button></div>
        ${errHtml}<div class="al-row"><button class="al-btn" data-a="signout">Sign out</button><button class="al-btn primary" data-a="close">Done</button></div>`;
    } else if (step === "sent") {
      card.innerHTML = `<h2>Check your email</h2><p>We've sent a sign-in link to ${escapeHtml(email)}. Open it on this device and you'll be signed in. You can close this.</p>
        ${errHtml}<div class="al-row"><button class="al-btn" data-a="back">Use a different email</button><button class="al-btn primary" data-a="close">Done</button></div>`;
    } else {
      card.innerHTML = `<h2>Sign in to sync</h2><p>Until you sign in, entries are kept on this device only.</p>
        <input type="email" autocomplete="email" placeholder="Email" data-f="email" value="${escapeHtml(email)}">
        <input type="password" autocomplete="current-password" placeholder="Password (leave blank for an emailed link)" data-f="pw">${errHtml}
        <div class="al-row"><button class="al-btn" data-a="close">Not now</button><button class="al-btn primary" data-a="send">Sign in</button></div>`;
    }
    card.querySelector("input")?.focus();
  }

  card.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a || a === "import") return;
    flash = "";
    try {
      if (a === "close") sheet.hidden = true;
      if (a === "back") renderSheet();
      if (a === "send") {
        email = card.querySelector('[data-f="email"]').value.trim();
        const pw = card.querySelector('[data-f="pw"]').value;
        if (pw) { await signInWithPassword(email, pw); sheet.hidden = true; }
        else { await sendCode(email); renderSheet("sent"); }
      }
      if (a === "password") renderSheet("password");
      if (a === "setpw") { await setPassword(card.querySelector('[data-f="newpw"]').value); flash = "Password saved."; await renderSheet(); }
      if (a === "signout") { await signOut(); renderSheet(); }
      if (a === "export") exportBackup(ALL_APPS);
    } catch (err) {
      renderSheet(a === "setpw" ? "password" : null, err.message || "Something went wrong. Try again.");
    }
  });
  // Enter in any box presses the card's main button.
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) { e.preventDefault(); card.querySelector(".al-btn.primary")?.click(); }
  });
  card.addEventListener("change", async (e) => {
    if (e.target.dataset.a !== "import" || !e.target.files[0]) return;
    try { await importBackup(e.target.files[0]); flash = "Backup restored."; await renderSheet(null, ""); }
    catch { renderSheet(null, "That file isn't an Alfred backup."); }
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
