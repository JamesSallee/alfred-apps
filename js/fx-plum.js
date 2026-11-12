// A plum branch in woodblock style whose blossoms open as the day's habits are ticked: none at
// breakfast, full flower when everything's done. Adapted from Forever Components' "Plum Branch"
// (Ukiyo-e Weather & Road). Blossoms only animate when they newly open; nothing loops except a slow
// sway once the branch is in full flower. Reduced motion: blossoms simply appear.
//
//   import { mountPlum } from "./js/fx-plum.js";
//   const plum = mountPlum();          // returns { el, set }; mountPlum({ mini: true }) for a short strip
//   someContainer.prepend(plum.el);    // the element survives re-renders: move it, don't rebuild it
//   plum.set(3, 6);                    // 3 of 6 habits ticked

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NS = "http://www.w3.org/2000/svg";

const CSS = `
.fx-plum{position:relative;height:150px;border-radius:14px;border:1px solid var(--line);overflow:hidden;
  background:linear-gradient(160deg,var(--plum-sky1),var(--plum-sky2) 45%,var(--plum-sky3))}
.fx-plum.mini{height:84px;margin-top:4px}
.fx-plum.mini .cap{display:none}
.fx-plum svg{position:absolute;inset:0;width:100%;height:100%}
.fx-plum .cap{position:absolute;left:12px;bottom:10px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--plum-cap);background:var(--plum-capbg);padding:3px 8px;border-radius:999px}
.fx-plum .bl{transform-box:fill-box;transform-origin:center;opacity:0;transform:scale(.2);transition:opacity .2s}
.fx-plum .bl.open{opacity:1;transform:none}
.fx-plum .bl.bloom{animation:fx-plum-bloom 1.1s ease-out both}
.fx-plum .bud{transform-box:fill-box;transform-origin:center}
.fx-plum.full .sway{animation:fx-plum-sway 7s ease-in-out infinite}
@keyframes fx-plum-bloom{0%{transform:scale(.2);opacity:0}60%{transform:scale(1.1);opacity:1}100%{transform:none;opacity:1}}
@keyframes fx-plum-sway{0%,100%{transform:rotate(-1deg)}50%{transform:rotate(1deg)}}
.fx-plum{--plum-sky1:#a9c3d6;--plum-sky2:#dfe6e4;--plum-sky3:#f8faf6;--plum-hill:#1f4d3a;--plum-branch:#3b2a22;
  --plum-petal1:#ffffff;--plum-petal2:#f7e8ef;--plum-petal3:#f2dbe6;--plum-edge:#9a5b3b;--plum-heart:#a87a1f;
  --plum-cap:#1d2b24;--plum-capbg:rgba(248,250,246,.8)}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .fx-plum{--plum-sky1:#101a2e;--plum-sky2:#1b2b2c;--plum-sky3:#18241f;
  --plum-hill:#7fbf9d;--plum-branch:#c9b8a8;--plum-edge:#e58f75;--plum-heart:#d9ad55;--plum-cap:#e6ece7;--plum-capbg:rgba(24,36,31,.8)}}
:root[data-theme="dark"] .fx-plum{--plum-sky1:#101a2e;--plum-sky2:#1b2b2c;--plum-sky3:#18241f;
  --plum-hill:#7fbf9d;--plum-branch:#c9b8a8;--plum-edge:#e58f75;--plum-heart:#d9ad55;--plum-cap:#e6ece7;--plum-capbg:rgba(24,36,31,.8)}
@media (prefers-reduced-motion: reduce){.fx-plum .bl.bloom{animation:none}.fx-plum.full .sway{animation:none}}
`;

// Eleven blossoms, ordered so the branch fills from the trunk outwards.
const TIPS = [[185, 185], [150, 170], [205, 205], [130, 150], [100, 160], [155, 148], [165, 120], [120, 128], [90, 128], [70, 120], [40, 165], [60, 140]].slice(0, 11);

export function mountPlum({ mini = false } = {}) {
  if (!document.getElementById("fx-plum-css")) {
    const st = document.createElement("style"); st.id = "fx-plum-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "fx-plum" + (mini ? " mini" : "");
  el.setAttribute("role", "img");
  el.innerHTML = `<svg viewBox="0 0 340 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <path d="M0 300 L0 215 Q70 175 130 205 L175 160 L210 200 Q280 180 340 210 L340 300 Z" fill="var(--plum-hill)" opacity=".18"/>
    <path d="M0 300 L0 255 Q120 235 200 257 Q300 275 340 255 L340 300 Z" fill="var(--plum-hill)" opacity=".3"/>
    <g class="sway" style="transform-box:view-box;transform-origin:300px 290px">
      <g fill="none" stroke="var(--plum-branch)" stroke-linecap="round">
        <path d="M300 300 C 280 250, 250 230, 200 215 C 150 200, 110 175, 70 120" stroke-width="8"/>
        <path d="M205 213 C 200 180, 175 160, 130 150" stroke-width="5"/>
        <path d="M150 198 C 165 175, 175 150, 165 120" stroke-width="4"/>
        <path d="M110 175 C 90 160, 70 155, 40 165" stroke-width="3.5"/>
      </g>
      <g class="blossoms"></g>
    </g>
  </svg><span class="cap"></span>`;
  const g = el.querySelector(".blossoms");
  const blossoms = TIPS.map(([cx, cy], bi) => {
    const b = document.createElementNS(NS, "g");
    const R = 6.5 + ((bi * 0.37) % 1) * 2.5;
    // A small bud is always there; the blossom opens over it.
    let html = `<circle class="bud" cx="${cx}" cy="${cy}" r="2.6" fill="var(--plum-edge)" opacity=".7"/>`;
    html += `<g class="bl">`;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      html += `<circle cx="${(cx + Math.cos(a) * R).toFixed(1)}" cy="${(cy + Math.sin(a) * R).toFixed(1)}" r="${(R * 0.62).toFixed(1)}"
        fill="var(--plum-petal${(bi % 3) + 1})" stroke="var(--plum-edge)" stroke-width=".6"/>`;
    }
    html += `<circle cx="${cx}" cy="${cy}" r="2.4" fill="var(--plum-heart)"/></g>`;
    b.innerHTML = html;
    g.appendChild(b);
    return b.querySelector(".bl");
  });

  let shown = -1;
  /** `done` of `total` ticked. Newly opened blossoms bloom; ones already open stay put. */
  function set(done, total) {
    const n = total > 0 ? (done >= total ? TIPS.length : Math.round((done / total) * TIPS.length)) : 0;
    blossoms.forEach((b, i) => {
      const open = i < n;
      const fresh = open && shown >= 0 && i >= shown;   // first paint: no fireworks, just the state
      b.classList.toggle("open", open);
      if (fresh && !REDUCED) { b.classList.remove("bloom"); void b.getBBox(); b.style.animationDelay = ((i - shown) * 0.12).toFixed(2) + "s"; b.classList.add("bloom"); }
      if (!open) b.classList.remove("bloom");
    });
    shown = n;
    el.classList.toggle("full", total > 0 && done >= total);
    const cap = el.querySelector(".cap");
    cap.textContent = total ? (done >= total ? "In full flower" : `${done} of ${total} in bloom`) : "Waiting for habits";
    el.setAttribute("aria-label", total ? `A plum branch with ${n} of ${TIPS.length} blossoms open: ${done} of ${total} habits done` : "A bare plum branch");
  }
  return { el, set };
}
