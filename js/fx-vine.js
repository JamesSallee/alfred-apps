// A vine that grows along a strip as the day's ticks come in: one leaf for each habit or calendar job, and the
// bud at its tip opens into a flower when everything's done. Adapted from Forever Components' "Growing Vine"
// (Organic & Nature), which grows and retracts on a loop; here it grows only when you tick, lies sideways so it
// fits under a heading, and stands still once it has caught up (nothing runs in the background on the console).
// Any number of items works: the leaves space themselves out. Reduced motion: it simply shows the state.
//
//   import { mountVine } from "./js/fx-vine.js";
//   const vine = mountVine();          // returns { el, set }; mountVine({ mini: true }) for a thin strip
//   someContainer.prepend(vine.el);    // the element survives re-renders: move it, don't rebuild it
//   vine.set(3, 11);                   // 3 of 11 ticked

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CSS = `
.fx-vine{position:relative;height:120px;border-radius:14px;border:1px solid var(--line);overflow:hidden;flex:none;
  background:linear-gradient(180deg,var(--vine-bg1),var(--vine-bg2))}
.fx-vine.mini{height:46px;border-radius:10px}
.fx-vine.mini .cap{display:none}
.fx-vine canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.fx-vine .cap{position:absolute;left:12px;bottom:9px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--vine-cap);background:var(--vine-capbg);padding:3px 8px;border-radius:999px}
.fx-vine{--vine-bg1:#eef5ee;--vine-bg2:#f8faf6;--vine-stem:#5aa870;--vine-stem2:#14532b;--vine-leaf0:#2e7d4b;--vine-leaf1:#69bd82;
  --vine-bud:#a87a1f;--vine-petal:#fbf3df;--vine-edge:#c9a35a;--vine-heart:#a87a1f;--vine-cap:#14532b;--vine-capbg:rgba(248,250,246,.85)}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .fx-vine{--vine-bg1:#0d2818;--vine-bg2:#13301f;--vine-stem:#2f7a47;
  --vine-stem2:#78ae4c;--vine-leaf0:#3aa55f;--vine-leaf1:#78ae4c;--vine-bud:#e3d894;--vine-petal:#f4ecd0;--vine-edge:#d9ad55;--vine-heart:#d9ad55;
  --vine-cap:#a9c98b;--vine-capbg:rgba(13,40,24,.8)}}
:root[data-theme="dark"] .fx-vine{--vine-bg1:#0d2818;--vine-bg2:#13301f;--vine-stem:#2f7a47;--vine-stem2:#78ae4c;--vine-leaf0:#3aa55f;
  --vine-leaf1:#78ae4c;--vine-bud:#e3d894;--vine-petal:#f4ecd0;--vine-edge:#d9ad55;--vine-heart:#d9ad55;--vine-cap:#a9c98b;--vine-capbg:rgba(13,40,24,.8)}
`;

const START = 0.03, SPAN = 0.88;                       // the stem runs from 3% to 91% of the width when fully grown
const frac = (v) => v - Math.floor(v);
const leafScale = (i) => 0.82 + 0.36 * frac(Math.sin(i * 12.9898 + 4.1) * 43758.5453); // steady sizes, no reshuffle on reload

export function mountVine({ mini = false } = {}) {
  if (!document.getElementById("fx-vine-css")) {
    const st = document.createElement("style"); st.id = "fx-vine-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  const el = document.createElement("div");
  el.className = "fx-vine" + (mini ? " mini" : "");
  el.setAttribute("role", "img");
  el.innerHTML = `<canvas aria-hidden="true"></canvas><span class="cap"></span>`;
  const cv = el.querySelector("canvas"), x = cv.getContext("2d");
  let W = 0, H = 0, total = 0, done = 0;
  let p = 0, target = 0;          // drawn growth and where it's heading, 0..1
  let bloom = 0, bloomTo = 0;     // the flower at the tip, 0..1
  let raf = 0, first = true;
  const C = {};

  function colours() {
    const cs = getComputedStyle(el);
    for (const k of ["stem", "stem2", "leaf0", "leaf1", "bud", "petal", "edge", "heart"]) C[k] = cs.getPropertyValue("--vine-" + k).trim();
  }
  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    if (!W || !H) return false;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  // The stem as a gentle sideways wave; s runs 0..1 across the strip.
  const pt = (s) => ({ x: W * s, y: H * (mini ? 0.5 : 0.4) + Math.sin(s * 8.5 + Math.sin(s * 3) * 1.4) * H * (mini ? 0.15 : 0.14) });

  function leaf(px, py, ang, sz, g) {
    x.save(); x.translate(px, py); x.rotate(ang);
    const gr = x.createLinearGradient(0, 0, sz * 2, 0);
    gr.addColorStop(0, C.leaf0); gr.addColorStop(1, C.leaf1);
    x.fillStyle = gr; x.globalAlpha = g;
    x.beginPath(); x.moveTo(0, 0);
    x.quadraticCurveTo(sz * 1.1, -sz * 0.9, sz * 2.1, 0);
    x.quadraticCurveTo(sz * 1.1, sz * 0.9, 0, 0); x.fill();
    x.restore();
  }
  function flower(px, py, r, k) {
    x.save(); x.translate(px, py); x.scale(k, k); x.rotate(-0.3);
    x.fillStyle = C.petal; x.strokeStyle = C.edge; x.lineWidth = 0.8;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      x.beginPath(); x.ellipse(Math.cos(a) * r, Math.sin(a) * r, r * 0.78, r * 0.55, a, 0, Math.PI * 2); x.fill(); x.stroke();
    }
    x.fillStyle = C.heart; x.beginPath(); x.arc(0, 0, r * 0.45, 0, Math.PI * 2); x.fill();
    x.restore();
  }

  function draw() {
    if (!W && !size()) return;
    x.clearRect(0, 0, W, H);
    const tip = START + p * SPAN;
    // stem: a darker underlay and a bright line on top
    x.lineCap = "round"; x.lineJoin = "round";
    const steps = 90;
    for (let pass = 0; pass < 2; pass++) {
      x.beginPath();
      for (let i = 0; i <= steps; i++) {
        const s = START + (i / steps) * (tip - START), q = pt(s);
        i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y);
      }
      x.strokeStyle = pass ? C.stem2 : C.stem;
      x.lineWidth = (pass ? 1.6 : 3.6) * (mini ? 0.85 : 1);
      x.globalAlpha = pass ? 0.9 : 1;
      x.stroke();
    }
    x.globalAlpha = 1;
    // a leaf for each item, appearing as the tip passes it
    if (total > 0) {
      const gap = (W * SPAN) / total;
      const base = Math.max(3, Math.min(gap * 0.42, H * (mini ? 0.15 : 0.1)));
      for (let i = 0; i < total; i++) {
        const s = START + ((i + 0.6) / total) * SPAN;
        if (tip <= s) break;
        const g = Math.min(1, (tip - s) * total * 3);
        const a = pt(s), b = pt(s + 0.004), dir = Math.atan2(b.y - a.y, b.x - a.x);
        const side = i % 2 ? 1 : -1;
        leaf(a.x, a.y, dir + side * 0.95, base * leafScale(i) * g, g);
      }
    }
    // the bud at the tip, opening into a flower when the day is done
    const q = pt(tip), r = mini ? 4.2 : 7;
    if (bloom < 1) { x.globalAlpha = 1 - bloom; x.fillStyle = C.bud; x.beginPath(); x.arc(q.x, q.y, mini ? 2.8 : 3.6, 0, Math.PI * 2); x.fill(); x.globalAlpha = 1; }
    if (bloom > 0) flower(q.x, q.y, r, 0.2 + 0.8 * bloom);
  }

  function step() {
    raf = 0;
    const dp = target - p;
    p += Math.abs(dp) < 0.002 ? dp : dp * 0.08;
    // The flower opens once the vine has reached the end, and closes straight away on an untick.
    const want = bloomTo && Math.abs(target - p) < 0.01 ? 1 : bloomTo ? bloom : 0;
    const db = want - bloom;
    bloom += Math.abs(db) < 0.01 ? db : db * (want ? 0.1 : 0.3);
    draw();
    if (p !== target || bloom !== bloomTo) raf = requestAnimationFrame(step);
  }
  function kick() {
    if (REDUCED || first || document.hidden) { p = target; bloom = bloomTo; draw(); return; }
    if (!raf) raf = requestAnimationFrame(step);
  }

  /** `d` of `t` ticked. The vine grows (or shrinks back) to match; the flower opens at t of t. */
  function set(d, t) {
    total = Math.max(0, t | 0); done = Math.max(0, Math.min(d | 0, total));
    target = total ? done / total : 0;
    bloomTo = total > 0 && done >= total ? 1 : 0;
    colours(); kick(); first = false;
    const cap = el.querySelector(".cap");
    cap.textContent = total ? (done >= total ? "In flower" : `${done} of ${total} grown`) : "Waiting for today";
    el.setAttribute("aria-label", total ? `A vine with ${done} of ${total} leaves${done >= total ? " and a flower open" : ""}` : "A bare vine");
  }

  // Redraw when the strip changes size or the theme changes.
  new ResizeObserver(() => { if (size()) { colours(); draw(); } }).observe(el);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colours(); draw(); });
  new MutationObserver(() => { colours(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && raf === 0) draw(); });
  return { el, set };
}
