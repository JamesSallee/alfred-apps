// Paper lanterns along a path at dusk, one lit for each step done. Adapted from Forever Components'
// "Lantern Path" (Ukiyo-e Weather & Road). Here nothing loops: the sky darkens and the lanterns light
// only as you move through the steps, with a short CSS transition. Reduced motion: no transition.
//
//   import { mountLanterns } from "./js/fx-lanterns.js";
//   const path = mountLanterns(el, 7);
//   path.set(3);   // three steps done, the fourth is the one you're on

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CSS = `
.fx-path{position:relative;overflow:hidden;border-radius:14px;border:1px solid var(--line);height:120px;
  --lp-ink:#16202b;--lp-glow:255,196,110;background:var(--lp-sky,#bcd0e0);transition:background 1.2s ease}
.fx-path .road{position:absolute;left:0;right:0;bottom:0;height:22%;background:linear-gradient(#3a3128,#2a2420);opacity:.9}
.fx-path .hill{position:absolute;left:-5%;right:-5%;bottom:20%;height:34%;border-radius:50% 50% 0 0/100% 100% 0 0;background:var(--lp-hill,#1f4d3a);opacity:.55}
.fx-path .hill.far{bottom:30%;height:30%;left:20%;right:-30%;opacity:.3}
.fx-path .lan{position:absolute;transform:translateX(-50%)}
.fx-path .globe{width:var(--lw);height:calc(var(--lw)*1.28);border-radius:46% 46% 42% 42%/52% 52% 48% 48%;background:#2c3a48;
  border:1.5px solid var(--lp-ink);position:relative;transition:background .9s ease,box-shadow .9s ease}
.fx-path .globe::before{content:"";position:absolute;left:18%;right:18%;top:0;bottom:0;border-radius:inherit;
  background:repeating-linear-gradient(0deg,rgba(22,32,43,.2) 0 2px,transparent 2px 6px)}
.fx-path .cap{position:absolute;left:50%;top:-5px;transform:translateX(-50%);width:70%;height:5px;background:var(--lp-ink);border-radius:3px 3px 0 0}
.fx-path .post{position:absolute;left:50%;top:100%;transform:translateX(-50%);width:2px;background:var(--lp-ink)}
.fx-path .lit .globe{background:radial-gradient(circle at 50% 42%,#ffd98a,#e8943a 70%,#b85e26);box-shadow:0 0 18px 4px rgba(var(--lp-glow),.55)}
.fx-path .now .globe{background:radial-gradient(circle at 50% 42%,#ffe9b8,#f0b660 70%,#c98a3a);box-shadow:0 0 10px 2px rgba(var(--lp-glow),.35);
  animation:fx-lp-flicker 3.2s ease-in-out infinite}
@keyframes fx-lp-flicker{0%,100%{box-shadow:0 0 10px 2px rgba(var(--lp-glow),.3)}50%{box-shadow:0 0 16px 4px rgba(var(--lp-glow),.5)}}
@media (prefers-reduced-motion: reduce){.fx-path,.fx-path .globe{transition:none}.fx-path .now .globe{animation:none}}
`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, k) => "rgb(" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * k)).join(",") + ")";

export function mountLanterns(host, n = 7) {
  if (!host) return { set() {} };
  if (!document.getElementById("fx-path-css")) {
    const st = document.createElement("style"); st.id = "fx-path-css"; st.textContent = CSS; document.head.appendChild(st);
  }
  host.classList.add("fx-path");
  host.setAttribute("role", "img");
  host.innerHTML = '<div class="hill"></div><div class="hill far"></div><div class="road"></div>';
  const globes = [];
  // One lantern over each step's label below, on a path that runs along the foot of the hills.
  for (let i = 0; i < n; i++) {
    const lan = document.createElement("div");
    lan.className = "lan";
    lan.style.setProperty("--lw", "22px");
    lan.style.left = ((i + 0.5) / n) * 100 + "%";
    lan.style.bottom = "22%";
    lan.innerHTML = `<div class="globe"><div class="cap"></div></div><div class="post" style="height:16px"></div>`;
    host.appendChild(lan);
    globes.push(lan);
  }

  /** `done` steps lit; the next one glows faintly as the one you're on. Below 0: not started. */
  function set(done) {
    const k = Math.max(0, Math.min(1, done / n));
    // Evening falls as the week closes: a pale dusk at the start, deep indigo at the end.
    host.style.setProperty("--lp-sky", `linear-gradient(${mix("#bcd0e0", "#16202b", k * 0.92)}, ${mix("#e6dcc8", "#142a47", k * 0.9)})`);
    host.style.background = `var(--lp-sky)`;
    globes.forEach((g, i) => { g.classList.toggle("lit", i < done); g.classList.toggle("now", i === done && done >= 0 && done < n); });
    host.setAttribute("aria-label", done <= 0 ? "A road of unlit lanterns at dusk" : done >= n ? "Every lantern on the road is lit" : `${done} of ${n} lanterns lit`);
  }
  set(-1);
  return { set };
}
